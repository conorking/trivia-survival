# CI/CD: push-to-deploy onto the home-hosted instance

For the setup documented in `CLAUDE.md`'s "Home hosting deployment" section:
the game runs in Docker on a separate always-on Windows mini PC (`C:\hosting`,
reached over RDP — not this dev machine), behind the `home-hosting` Cloudflare
Tunnel on the `cking.co.nz` domain. This adds `git push` → live-on-that-box,
without opening any inbound port beyond what the tunnel already exposes, and
without giving GitHub Actions a persistent presence (a self-hosted runner,
SSH access) on the box.

## How it works

```
push to master
      │
      ▼
GitHub Actions (.github/workflows/deploy.yml)
      │  builds the Docker image, pushes it to ghcr.io (private)
      ▼
      │  one POST, Authorization: Bearer <token>, to a Cloudflare-tunneled
      │  hostname on the mini PC
      ▼
Watchtower (deploy/docker-compose.yml, HTTP-API mode)
      │  pulls the new :latest image, recreates the triviasurvival container
      ▼
Live instance updated
```

Watchtower is the piece that makes this a *push*, not a poll: it's configured
with `WATCHTOWER_HTTP_API_UPDATE=true` and no interval/schedule set at all,
which means it does nothing on its own — it only checks/updates
label-enabled containers the instant its one HTTP endpoint is hit. Between
deploys there's no periodic registry traffic and nothing listening for
inbound connections beyond the tunnel that's already there.

GitHub Actions itself is scoped to exactly two capabilities the whole way
through: push an image to a package registry it owns (`packages: write` on
the built-in `GITHUB_TOKEN`, nothing broader), and make one authenticated
HTTP call to one fixed URL. No self-hosted runner, no SSH/shell access.

## One-time host setup (on the mini PC, via RDP)

**1. Replace the existing compose service's `build:` with an `image:` pull.**

`C:\hosting\docker-compose.yml` currently has a `triviasurvival` service using
`build: C:/source/trivia-survival` — a local build from a checked-out copy of
this repo. Swap just that to pull the image GitHub Actions now publishes
instead — copy this repo's `deploy/docker-compose.yml` over it (or merge by
hand if `C:\hosting\docker-compose.yml` has grown other services since). The
service/container name (`triviasurvival`) and port (`3000`, unpublished,
tunnel-only) are unchanged on purpose, so the tunnel's existing ingress rule
(`service: http://triviasurvival:3000`) needs no edits at all — you're only
adding the new `watchtower` service alongside it.

**2. Give Watchtower a way to pull your private GHCR image.**

Create a GitHub [Personal Access Token](https://github.com/settings/tokens)
(classic is simplest) scoped to just `read:packages`.

Docker Desktop for Windows stores `docker login` credentials via the OS
credential manager by default, *not* embedded in `config.json` — which means
a normal `docker login` here won't actually give the Watchtower container
(a Linux container reading a plain file) anything usable. Instead, build
Watchtower a small dedicated auth file directly, in PowerShell:

```powershell
cd C:\hosting
mkdir watchtower-docker-config
$pair = "<your-github-username>:<your-PAT>"
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
@"
{"auths":{"ghcr.io":{"auth":"$b64"}}}
"@ | Set-Content -Encoding utf8 watchtower-docker-config\config.json
```

This file only grants pull access to your own GHCR images — keep it out of
git (it already sits under `C:\hosting`, which isn't a repo checkout).

**3. Set up the compose stack.**

```powershell
cd C:\hosting
copy deploy\.env.example .env   # from this repo, or hand-create it
```

Edit `.env` and set `WATCHTOWER_HTTP_API_TOKEN` to a long random value —
easiest generated via Docker itself, so you don't need `openssl` on PATH:

```powershell
docker run --rm alpine sh -c "head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n'"
```

Then bring the stack up:

```powershell
docker compose up -d
docker compose logs -f watchtower   # confirm it started in HTTP-API mode,
                                     # with no scheduled-poll message
```

**4. Route a hostname to Watchtower on the `home-hosting` tunnel.**

One more public hostname on the same named tunnel that already serves
`triviasurvival.cking.co.nz`, pointed at the new `watchtower` service instead:

- **Zero Trust dashboard**: `home-hosting` tunnel → **Public Hostname** →
  **Add a public hostname** → e.g. `deploy-triviasurvival.cking.co.nz` →
  Service `http://watchtower:8080`.
- **Or via the tunnel's `config.yml`**, add an ingress rule alongside the
  existing one:

  ```yaml
  ingress:
    - hostname: triviasurvival.cking.co.nz
      service: http://triviasurvival:3000
    - hostname: deploy-triviasurvival.cking.co.nz
      service: http://watchtower:8080
    - service: http_status:404
  ```

  then `cloudflared tunnel ingress validate` and restart the `cloudflared`
  service/container.

This hostname is protected only by Watchtower's own bearer-token check (same
trust model as a Stripe/GitHub/Docker Hub webhook — a long random secret over
HTTPS). Don't publish it anywhere; treat the token like a password.

## GitHub-side setup

In the repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `WATCHTOWER_HTTP_API_TOKEN` | the same token you put in `.env` on the mini PC |
| `DEPLOY_WEBHOOK_URL` | `https://deploy-triviasurvival.cking.co.nz/v1/update` |

Nothing else to configure — `.github/workflows/deploy.yml` uses the
repo-provided `GITHUB_TOKEN` for the GHCR push, so there's no separate PAT to
create or rotate on the CI side.

## What happens on every push to `master`

1. GitHub Actions builds the image from the repo's `Dockerfile`.
2. Pushes it to `ghcr.io/conorking/trivia-survival` as both `:latest` (the
   tag the running container tracks) and `:sha-<commit>` (an immutable tag,
   kept around purely for rollback — see below).
3. POSTs to the deploy webhook with the bearer token.
4. Watchtower receives that, pulls the new `:latest`, and recreates the
   `triviasurvival` container. Typically live within seconds of the workflow
   finishing.

You can also trigger a deploy manually without a new commit: the workflow
has `workflow_dispatch` enabled, so **Actions → Build and deploy → Run
workflow** re-runs it against whatever `master` currently points to.

## Rollback

Every past build is still sitting in GHCR under its `:sha-<commit>` tag. To
roll back, on the mini PC:

```powershell
docker pull ghcr.io/conorking/trivia-survival:sha-<old-commit-sha>
docker tag ghcr.io/conorking/trivia-survival:sha-<old-commit-sha> `
           ghcr.io/conorking/trivia-survival:latest
docker compose up -d triviasurvival
```

(Find `<old-commit-sha>` from GitHub's commit history, or the package
version list at `github.com/conorking/trivia-survival/pkgs/container/trivia-survival`.)
The next real push overwrites `:latest` again as normal.

## Adding a future project on the same mini PC

This was designed to repeat cleanly:

1. Give the new project a `Dockerfile` and copy this repo's
   `.github/workflows/deploy.yml` into it unchanged — the image name is
   derived from `github.repository` automatically, nothing to edit.
2. Add one more service block to `C:\hosting\docker-compose.yml` (own image,
   own container name, own `expose` port), keeping the
   `com.centurylinklabs.watchtower.enable=true` label. One shared Watchtower
   instance is enough for every project on the box — its label filter means
   it only ever touches containers that opt in, and a single update call
   cheaply re-checks all of them.
3. Add one more tunnel hostname on `home-hosting` if the new project needs
   its own public URL (same pattern as step 4 above).
4. Set the same two secret names (`WATCHTOWER_HTTP_API_TOKEN`,
   `DEPLOY_WEBHOOK_URL`) on the new repo. Reusing the exact same values is
   fine; issue the new project its own token instead if you'd rather keep
   projects independently revocable.

## Troubleshooting

- **Webhook call fails with 401/403**: the token in the GitHub secret
  doesn't match `WATCHTOWER_HTTP_API_TOKEN` in `.env` on the mini PC —
  re-copy it carefully, no surrounding quotes/whitespace.
- **Webhook call fails to connect at all**: check the tunnel route from step
  4 above — `cloudflared tunnel ingress validate` and the `cloudflared`
  container/service logs are the first places to look.
- **Deploy "succeeds" but the container never updates**: confirm the
  `triviasurvival` service in `docker-compose.yml` is pinned to the `:latest`
  tag (Watchtower only updates a container if a *newer* image exists for the
  tag it's already running), and check `docker compose logs watchtower` for a
  pull error — almost always the `watchtower-docker-config/config.json` from
  step 2 being stale, missing, or (if it was created with a plain
  `docker login` instead of the manual recipe above) pointing at the OS
  credential manager instead of embedding real credentials.
- **Build step fails in GitHub Actions**: check the Actions log directly —
  this is the same `Dockerfile` you can build locally with `docker build .`
  to reproduce.
