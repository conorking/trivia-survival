# Deploying to a free, always-on public URL (Oracle Cloud Always Free)

As of 2026, Render's free tier is gone, Fly.io's free tier is gone for new accounts, and
Railway has no real free plan either (~$1-5/mo minimum) — so none of them are actually
free anymore for an always-on WebSocket app. Oracle Cloud Infrastructure's **Always
Free** tier is the one major cloud that still gives real compute free forever, no time
limit, no credit-card-trap. This game needs almost nothing (a few hundred MB of RAM), so
even Oracle's tightened 2026 limits are massive overkill.

This gets you a persistent public HTTPS URL that's up 24/7, independent of your own
laptop. If you just want it public for a single event and don't want to run/maintain a
server, the tunnel approach in the main README (`npm run tunnel:ngrok` /
`tunnel:cloudflared`) is far less setup — this guide is for the "I want a stable URL
that's always there" case.

## What you'll end up with

- A free-forever Oracle Cloud VM running Ubuntu.
- The game running as a `systemd` service (auto-restarts on crash/reboot).
- [Caddy](https://caddyserver.com/) in front of it, handling free automatic HTTPS and
  WebSocket proxying with zero extra config.
- Only ports 80/443 exposed to the internet — the app's own port (3000) is never opened
  publicly, only reachable via Caddy on `localhost`.

## 1. Create the Oracle Cloud account and VM

1. Sign up at [cloud.oracle.com](https://www.oracle.com/cloud/free/) (a card is required
   for identity verification, but Always Free resources are not billed).
2. In the console: **Compute → Instances → Create Instance**.
3. **Image**: Canonical Ubuntu (22.04 or 24.04 LTS) — best-documented for this setup.
4. **Shape**: click *Change Shape* → Ampere → `VM.Standard.A1.Flex`, and set it to
   **1 OCPU / 6 GB memory** (comfortably Always-Free-eligible even under the tightened
   2026 caps, and far more than this app needs — leaves headroom if you ever want to
   self-host something else on the same box too). If you'd rather avoid ARM entirely,
   the older `VM.Standard.E2.1.Micro` (x86, 1 OCPU/1GB) is also Always Free and plenty
   for this app.
5. **Networking**: keep the default VCN, and make sure **"Assign a public IPv4 address"**
   is checked.
6. **SSH keys**: let Oracle generate a key pair for you and download the private key (or
   paste in your own public key if you already have one). You'll need this to log in.
7. Create the instance, note its **public IP address** once it's running.

## 2. Open the firewall (the part almost everyone trips on)

Oracle Cloud has **two** separate firewalls that both default to blocking inbound
traffic — you need to open both, not just one:

**a) The cloud-level firewall (Security List)**
Console → your VCN → **Security Lists** → the default list → **Add Ingress Rules**:
- Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port `80`
- Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port `443`

Do **not** open port 3000 here — the app should only ever be reached through Caddy.

**b) The OS-level firewall on the VM itself**
Oracle's Ubuntu images ship with `iptables` rules that block everything except SSH by
default, *in addition to* the cloud firewall above. SSH in
(`ssh -i your-key.pem ubuntu@<public-ip>`) and run:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save   # or: sudo apt install -y iptables-persistent (first time)
```

## 3. Install Node.js, git, and Caddy

```bash
# Node.js LTS (this project needs 18+)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Caddy (adds its own apt repo)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

## 4. Deploy the app

Create a dedicated non-root user to run the game (never run it as root):

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin trivia
sudo mkdir -p /opt/trivia-survival
sudo chown trivia:trivia /opt/trivia-survival
```

Clone the repo and install dependencies (as the `trivia` user, or clone as yourself and
`chown -R trivia:trivia /opt/trivia-survival` afterward):

```bash
sudo -u trivia git clone <your-repo-url> /opt/trivia-survival
cd /opt/trivia-survival
sudo -u trivia npm install --omit=dev
```

## 5. Run it as a systemd service

Copy this repo's `deploy/trivia-survival.service` onto the VM:

```bash
sudo cp /opt/trivia-survival/deploy/trivia-survival.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trivia-survival
sudo systemctl status trivia-survival   # should show "active (running)"
```

It's now listening on `127.0.0.1:3000` (well, `0.0.0.0:3000`, but unreachable from the
internet since only 80/443 are open) and will restart automatically on crash or reboot.

## 6. Put Caddy in front for HTTPS

Edit `deploy/Caddyfile` (see the comments in that file) to use either your own domain
(point an A record at the VM's public IP) or the free `sslip.io` trick if you don't own
a domain, then:

```bash
sudo cp /opt/trivia-survival/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Caddy will automatically request and renew a Let's Encrypt certificate for that
hostname the first time it starts.

## 7. Test it

Open `https://your-address-here` (whatever you put in the Caddyfile) from your phone —
you should land on the game's landing page over a real HTTPS connection, and the join
QR code/link the host page generates will automatically use that same public address
(it's built from `window.location.origin`, same as the LAN/tunnel cases — no app code
changes needed for any of this).

## Updating the app later

```bash
cd /opt/trivia-survival
sudo -u trivia git pull
sudo -u trivia npm install --omit=dev
sudo systemctl restart trivia-survival
```

## Troubleshooting

- **Can't connect at all**: check both firewalls from step 2 — this is the #1 cause.
  `curl -I http://localhost:80` from *on* the VM should work even if the outside world
  can't reach it yet; that tells you whether it's a Caddy/app problem or a firewall one.
- **Connects but no HTTPS certificate / browser warning**: your hostname isn't actually
  resolving to this VM's IP yet (DNS not propagated, or a typo in the `sslip.io` address)
  — Let's Encrypt has to be able to reach the VM at that hostname to issue a cert.
- **Service won't start**: `sudo journalctl -u trivia-survival -n 50` shows the actual
  Node error (most likely: dependencies not installed, or wrong Node version — this
  project needs 18+).
- **WebSocket connects then immediately drops**: almost always a firewall/proxy issue
  upstream of Caddy (e.g. a corporate network on the *player's* end blocking WebSockets)
  rather than anything on the server side, since Caddy proxies WebSocket upgrades
  natively.
