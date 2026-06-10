# Generic Docker Image

This guide covers the production Docker image outside the bundled VPS Compose files.

The image contains the built admin UI, Bun server, public renderer, CMS API routes, migrations, and runtime dependencies. It does not run Vite or install packages at container startup.

---

## TL;DR

Run the image with:

- `PORT` set to the platform's HTTP port
- `DATABASE_URL` pointing at SQLite or Postgres
- `UPLOADS_DIR` mounted on persistent storage
- `STATIC_DIR=/app/dist`
- `INSTATIC_SECRET_KEY` set before configuring AI provider credentials, plugin secret settings, or TOTP MFA

Use one persistent mount root when the platform only supports one app volume:

```txt
DATABASE_URL=sqlite:/app/storage/data/cms.db
UPLOADS_DIR=/app/storage/uploads
```

## Build Locally

```sh
docker build -t instatic:local .
```

## Published Image

GHCR is the canonical image registry:

```sh
docker pull ghcr.io/corebunch/instatic:latest
docker pull ghcr.io/corebunch/instatic:0.0.2
```

Docker Hub is a discoverability mirror:

```sh
docker pull corebunch/instatic:latest
docker pull corebunch/instatic:0.0.2
```

When both registries are available, prefer GHCR in Compose files because it is produced directly by the release workflow.

The v0.0.2 published image is built for `linux/amd64`. Use it on Railway and x86_64 VPS/container hosts. ARM64 hosts should build from source for now, or wait for the native arm64 release job before pulling GHCR images directly.

## Run With SQLite

Use this mode when the host can attach a persistent volume to the app container.

```sh
docker volume create instatic-storage

docker run -d \
  --name instatic \
  -p 3001:3001 \
  -e PORT=3001 \
  -e DATABASE_URL="sqlite:/app/storage/data/cms.db" \
  -e STATIC_DIR=/app/dist \
  -e UPLOADS_DIR=/app/storage/uploads \
  -e INSTATIC_SECRET_KEY="replace-with-output-of-generate-secret-key" \
  -v instatic-storage:/app/storage \
  --restart unless-stopped \
  instatic:local
```

The single volume stores both the SQLite database and uploaded media.

## Run With External Postgres

Use this mode when Postgres is provided by the host or by a separate managed database service.

```sh
docker volume create instatic-storage

docker run -d \
  --name instatic \
  -p 3001:3001 \
  -e PORT=3001 \
  -e DATABASE_URL="postgres://user:password@host:5432/instatic" \
  -e STATIC_DIR=/app/dist \
  -e UPLOADS_DIR=/app/storage/uploads \
  -e INSTATIC_SECRET_KEY="replace-with-output-of-generate-secret-key" \
  -v instatic-storage:/app/storage \
  --restart unless-stopped \
  instatic:local
```

The app volume is still required in Postgres mode because uploads, fonts, plugin packs, and published disk artefacts live under `UPLOADS_DIR`.

Replace `instatic:local` with `ghcr.io/corebunch/instatic:<tag>` when deploying from a published image.

## Run On Railway From The Image

Create an app service from Docker image source:

```txt
ghcr.io/corebunch/instatic:0.0.2
```

Attach a Railway volume at `/app/storage`, set the health check path to `/health`, and set app variables:

```txt
PORT=8080
DATABASE_URL=sqlite:/app/storage/data/cms.db
UPLOADS_DIR=/app/storage/uploads
STATIC_DIR=/app/dist
INSTATIC_SECRET_KEY=<output of bun run scripts/generate-secret-key.ts>
```

Enable Railway Image Auto Updates when you want Railway to move the service forward automatically during a maintenance window. Use `:latest` for "always follow the newest image", or a semver tag such as `:0.0.2` if you want Railway's semver update controls.

## Run On Render From The Image

Use the checked-in Render Blueprints when creating Deploy to Render template repositories:

```txt
docs/deployment/render/sqlite/render.yaml
docs/deployment/render/postgres/render.yaml
```

The SQLite Blueprint creates one image-backed web service and one persistent disk:

```txt
PORT=10000
DATABASE_URL=sqlite:/app/storage/data/cms.db
UPLOADS_DIR=/app/storage/uploads
STATIC_DIR=/app/dist
```

The Postgres Blueprint creates one image-backed web service, one persistent disk for uploads, and one Render Postgres database. See [render.md](render.md) for the full Render contract.


## Required Runtime Variables

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | Yes | `sqlite:...`, `file:...`, `postgres://...`, or `postgresql://...` |
| `UPLOADS_DIR` | Yes for durable media | Persistent upload directory |
| `STATIC_DIR` | Yes in Docker | `/app/dist` |
| `PORT` | Platform-dependent | HTTP listen port; defaults to `3001` |
| `INSTATIC_SECRET_KEY` | Yes for reversible server secrets | Output of `bun run scripts/generate-secret-key.ts` |

Managed platforms usually inject `PORT`. Do not hard-code a different listen port unless the platform asks for a fixed target port.

`INSTATIC_SECRET_KEY` is the stable AES master key for reversible server secrets, including Anthropic, OpenAI, and OpenRouter credentials and TOTP MFA seeds. If it is missing in production, adding a credential or enabling TOTP MFA fails. If it is rotated or lost, existing stored credentials must be re-entered and TOTP MFA must be re-enrolled.

## Health Check

```sh
curl http://localhost:3001/health
```

Expected response:

```json
{"status":"ok","ts":1234567890}
```

## Related

- [deployment/README.md](README.md) — deployment overview
- [railway.md](railway.md) — Railway template variables
- [render.md](render.md) — Render Blueprint variables
- [vps.md](vps.md) — Docker Compose install
- [backup-restore.md](backup-restore.md) — backing up DB and uploads
- `Dockerfile` — production image definition
- `server/config.ts` — runtime env parsing
