# CI/CD: push-to-deploy via a self-hosted GitHub Actions runner

For the setup documented in `CLAUDE.md`'s "Home hosting deployment" section:
the game runs in Docker on a separate always-on Windows mini PC (`C:\hosting`
for the compose stack, `C:\source\trivia-survival` for the actual code
checkout — reached over RDP, not this dev machine), behind the
`home-hosting` Cloudflare Tunnel on `cking.co.nz`. This makes `git push` to
`master` land on that live instance automatically.

## Why this design, not a webhook

An earlier version of this pipeline pushed images to GHCR and used
Watchtower (triggered by a webhook) to pull and restart the container on
push. That fell apart in practice — the Watchtower image turned out to be
archived/unmaintained and broken against current Docker Engine, and its
actively-maintained replacement is a single-maintainer fork, a real
bus-factor risk for something with Docker-socket-level power. Underneath
that, the design itself was the actual problem: a standing,
internet-reachable HTTP endpoint with Docker-socket-equivalent power behind
it, gated by nothing but a static bearer token, is a bespoke pattern with no
strong precedent - hardening it (a Docker socket proxy, etc.) would have
been fixing the wrong layer.

**A self-hosted GitHub Actions runner is the standard, well-precedented
answer to "deploy to infra you don't want to expose to the internet"** -
functionally the same idea as a Jenkins/CloudBees agent: a process on your
own infra that executes CI-dispatched jobs. It removes the standing network
listener entirely (the runner dials *out* to GitHub, the same direction
everything else here already runs), removes the Watchtower dependency
entirely, and removes all the webhook secret/environment/registry machinery
entirely - there's no secret to leak, because access is gated by "who can
push to this private repo's `master`" (GitHub's own account security), not
a string in an HTTP header.

**GitHub's own caution against self-hosted runners is specifically about
public repos with outside-PR triggers** - a stranger's pull request can get
a workflow dispatched to your runner before anyone reviews it. That doesn't
apply here: this repo is private, with no outside collaborators, and the
workflow only ever triggers on `push` (never `pull_request`). That's exactly
the configuration GitHub considers safe. **Keep it that way** - the
workflow file itself carries a comment warning against ever adding a
`pull_request` trigger without reconsidering this whole setup first.

This also simplifies everything downstream: since the runner executes
directly on the mini PC, there's no reason to push/pull an image through a
registry at all. The job just does what you'd do by hand over RDP -
`git pull`, `docker compose build`, `docker compose up -d` - just
automatically, on every push.

## How it works

```
push to master
      │
      ▼
Self-hosted runner (Windows service on the mini PC, registered to this
repo only, dispatched only by push-to-master)
      │  runs directly in the existing checkout at C:\source\trivia-survival
      ▼
  git pull
  docker compose -f C:\hosting\docker-compose.yml up -d --build triviasurvival
      ▼
Live instance updated
```

## One-time host setup (on the mini PC, via RDP)

**1. Register a runner for this repo.**

Repo → **Settings → Actions → Runners → New self-hosted runner** → OS
**Windows**, architecture **x64**. GitHub shows a short PowerShell script
with a **registration token** embedded - that token is short-lived and only
used once to link the runner to this repo; it isn't a secret you store
anywhere afterward. Run the shown commands in a PowerShell prompt on the
mini PC, e.g.:

```powershell
mkdir C:\actions-runner; cd C:\actions-runner
Invoke-WebRequest -Uri <the URL GitHub shows> -OutFile actions-runner.zip
Expand-Archive -Path actions-runner.zip -DestinationPath .
.\config.cmd --url https://github.com/conorking/trivia-survival --token <the token GitHub shows>
```

When `config.cmd` asks for labels, the default is fine (the workflow just
targets `self-hosted`, no custom label needed).

**2. Install it as a service that can actually reach Docker Desktop.**

This is the one real gotcha on Windows: Docker Desktop's engine is tied to
a logged-in user's session (it runs inside that user's WSL2 instance), not
a system-wide daemon the way Docker Engine is on Linux. A service running
as `LOCAL SYSTEM` frequently **cannot** reach it at all.

```powershell
.\svc.cmd install
```

When prompted for the account to run the service as, use the **same Windows
user account that already runs Docker Desktop and the `docker compose`
stack** today - not Local System. Then confirm that account is a member of
the local `docker-users` group (**Computer Management → Local Users and
Groups → Groups → docker-users**), and:

```powershell
.\svc.cmd start
```

Check **Services** (`services.msc`) for "GitHub Actions Runner
(...)" showing **Running**. If it won't reach Docker even after this (some
Docker Desktop/WSL2 combinations still don't hand off session-bound access
to a background service), the fallback is running the runner interactively
instead of as a service - `run.cmd` placed in that user's Startup folder (or
a Scheduled Task set to "run only when user is logged on") so it launches
inside their actual desktop session, which definitely has Docker access.

**3. Confirm the checkout the runner will operate on.**

The workflow assumes `C:\source\trivia-survival` is already a git clone of
this repo with a working `git pull` (origin reachable, no uncommitted local
changes that would block a pull) - which is also exactly what
`C:\hosting\docker-compose.yml`'s `build: C:/source/trivia-survival` already
assumes today. Nothing new to set up here if that's already true; just
worth confirming before the first real push.

## What happens on every push to `master`

1. The runner picks up the dispatched job (near-instantly - it maintains a
   persistent connection to GitHub, this isn't polling on an interval).
2. `git pull` in `C:\source\trivia-survival`.
3. `docker compose -f C:\hosting\docker-compose.yml up -d --build
   triviasurvival` - rebuilds just that service (it's the only one with a
   `build:` key; `cloudflared` is untouched) and recreates the container.

Typically live within the time it takes Docker to rebuild the changed
layers - fast in practice, since the build cache persists on the same
machine between runs (unlike a fresh GitHub-hosted runner every time).

You can also trigger a deploy manually without a new commit: the workflow
has `workflow_dispatch` enabled, so **Actions → Build and deploy → Run
workflow** re-runs it against whatever `master` currently points to.

## Rollback

No registry/image tags to juggle - it's a git checkout. On the mini PC:

```powershell
cd C:\source\trivia-survival
git checkout <old-commit-sha>
docker compose -f C:\hosting\docker-compose.yml up -d --build triviasurvival
```

Or, more normally, `git revert` the bad commit and push it - that goes
through the same pipeline as any other change and rebuilds automatically.
Either way, remember to `git checkout master` afterward so the next real
push doesn't fight a detached HEAD.

## Adding a future project on the same mini PC

1. Give the new project a `Dockerfile` and a `docker-compose.yml` entry
   alongside `triviasurvival` in `C:\hosting\docker-compose.yml` (own
   `build:` path, own network membership on `hosting_net` if `cloudflared`
   needs to reach it).
2. Register a runner for the new repo the same way (step 1 above) - a
   separate runner per repo is simplest and keeps them independent; you
   don't need to install a second copy of the runner software just to add
   labels, but a fresh `config.cmd` run against the new repo's URL is the
   straightforward path.
3. Copy this repo's `.github/workflows/deploy.yml` into the new repo,
   adjusting the two hardcoded paths (the checkout location and the compose
   `-f` path) if they differ.

No registry, no webhook, no secrets to provision at all - that's the actual
payoff of this design over the previous one.

## Troubleshooting

- **Push doesn't trigger anything / Actions tab shows the job queued
  forever**: the runner service isn't running - check `services.msc` on the
  mini PC, or `Settings → Actions → Runners` on GitHub (should show
  "Idle", not offline).
- **Job runs but the `docker compose` step fails with a connection/access
  error**: the runner service is very likely running as the wrong account
  (see step 2's Docker Desktop gotcha) - confirm it's logged on as the
  Docker-Desktop-capable user and that account is in `docker-users`.
- **`git pull` step fails**: something local in `C:\source\trivia-survival`
  is blocking it (uncommitted changes, detached HEAD from a rollback that
  never got checked back to `master`, diverged history) - RDP in and fix
  the checkout's state directly, same as you would for any git repo.
- **Build fails**: reproduce locally with the same `docker compose -f
  C:\hosting\docker-compose.yml build triviasurvival` - the Actions log
  shows the same output either way, this isn't hidden from you.
