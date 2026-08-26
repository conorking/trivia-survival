// One-command launcher: runs the game server and an ngrok tunnel together, so you don't
// need two terminals. Also makes the tunnel self-healing - if ngrok's agent process dies
// (network blip, RDP session hiccup, whatever) while the server keeps running, this
// notices and restarts just ngrok, instead of you coming back later to a "server's up
// but nobody can reach it" surprise.
//
// Usage:
//   npm run start:tunnel
//   npm run start:tunnel -- --domain=your-reserved-name.ngrok-free.app
//
// The optional --domain flag (or NGROK_DOMAIN env var) pins ngrok to a free static
// domain (set one up once at https://dashboard.ngrok.com/domains) so the public URL
// never changes across restarts - without it, every ngrok restart gets a new random
// *.ngrok-free.app URL, and anyone already looking at the host page's QR/link needs a
// page reload to pick up the new one (the host page only checks for a tunnel once per
// load, not continuously).
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;
const REPO_ROOT = path.join(__dirname, '..');
const domainArg = process.argv.find(a => a.startsWith('--domain='));
const NGROK_DOMAIN = (domainArg && domainArg.slice('--domain='.length)) || process.env.NGROK_DOMAIN || null;

let shuttingDown = false;
let ngrokRestartTimer = null;
let ngrokChild = null;
let serverChild = null;

function prefixPipe(stream, label) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) if (line.length) console.log(`[${label}] ${line}`);
  });
}

function startServer() {
  serverChild = spawn(process.execPath, [path.join('server', 'server.js')], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  prefixPipe(serverChild.stdout, 'server');
  prefixPipe(serverChild.stderr, 'server');
  serverChild.on('exit', (code) => {
    serverChild = null;
    if (shuttingDown) return;
    console.log(`[launcher] server process exited unexpectedly (code ${code}) - shutting down tunnel too.`);
    shutdown(1);
  });
}

function startNgrok() {
  if (shuttingDown) return;
  const args = ['http', String(PORT)];
  if (NGROK_DOMAIN) args.push(`--domain=${NGROK_DOMAIN}`);
  console.log(`[launcher] starting ngrok (ngrok ${args.join(' ')})...`);
  ngrokChild = spawn('ngrok', args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  });
  prefixPipe(ngrokChild.stdout, 'ngrok');
  prefixPipe(ngrokChild.stderr, 'ngrok');
  pollForPublicUrl();
  ngrokChild.on('exit', (code) => {
    ngrokChild = null;
    if (shuttingDown) return;
    console.log(`[launcher] ngrok exited (code ${code}) - restarting in 3s so the tunnel comes back on its own...`);
    ngrokRestartTimer = setTimeout(startNgrok, 3000);
  });
}

// Polls ngrok's own local admin API (same endpoint server.js's /api/tunnel-info checks)
// until the public URL shows up, then prints it - so restarts are visible here even if
// you're not watching the host page.
function pollForPublicUrl(attempt = 0) {
  if (shuttingDown || !ngrokChild) return;
  const req = http.get({ host: '127.0.0.1', port: 4040, path: '/api/tunnels', timeout: 800 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const tunnels = JSON.parse(body).tunnels || [];
        const best = tunnels.find(t => t.proto === 'https') || tunnels[0];
        if (best) {
          console.log(`[launcher] tunnel is up: ${best.public_url}  (reload the host page if it already had an older link open)`);
          return;
        }
      } catch (e) { /* fall through to retry */ }
      if (attempt < 15) setTimeout(() => pollForPublicUrl(attempt + 1), 1000);
    });
  });
  req.on('timeout', () => { req.destroy(); if (attempt < 15) setTimeout(() => pollForPublicUrl(attempt + 1), 1000); });
  req.on('error', () => { if (attempt < 15) setTimeout(() => pollForPublicUrl(attempt + 1), 1000); });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(ngrokRestartTimer);
  if (ngrokChild) ngrokChild.kill();
  if (serverChild) serverChild.kill();
  setTimeout(() => process.exit(exitCode), 200);
}

process.on('SIGINT', () => { console.log('\n[launcher] shutting down...'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

startServer();
startNgrok();
