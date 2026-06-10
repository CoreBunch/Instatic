# VPS Deployment

This guide covers Docker Compose installs on a single VPS.

The VPS stack uses the same production image as managed platforms. Compose only supplies local persistence, an optional bundled Postgres service, and an optional Caddy TLS proxy.

---

## TL;DR

| Mode | Source-build command | Containers | Persistent volumes |
|---|---|---|---|
| SQLite | `docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d --build` | `app` | `data`, `uploads` |
| Postgres | `docker compose -f compose.prod.yml -f compose.build.yml up -d --build` | `app`, `postgres` | `postgres_data`, `uploads` |
| SQLite + TLS | `docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.tls.yml -f compose.build.yml up -d --build` | `app`, `caddy` | `data`, `uploads`, `caddy_data` |
| Postgres + TLS | `docker compose -f compose.prod.yml -f compose.tls.yml -f compose.build.yml up -d --build` | `app`, `postgres`, `caddy` | `postgres_data`, `uploads`, `caddy_data` |

SQLite is the default for most single-site installs. Postgres is for multiple simultaneous admin writers, horizontal app scale, or operators who already want Postgres.

When using a published image, set `INSTATIC_IMAGE` and omit `compose.build.yml` plus `--build`.
Before adding AI provider credentials, saving plugin secret settings, or enabling TOTP MFA in production, set `INSTATIC_SECRET_KEY` to the output of `bun run scripts/generate-secret-key.ts`.

## Install From A Release Bundle

1. Download `instatic-<version>-release-bundle.tar.gz` from the GitHub Release.
2. Unpack it on the server.
3. Choose SQLite or Postgres.

SQLite:

```sh
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:<version> docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Postgres:

```sh
cp .env.production.example .env
# Set POSTGRES_PASSWORD and INSTATIC_SECRET_KEY in .env.
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:<version> docker compose -f compose.prod.yml up -d
```

## Prerequisites

Install Docker Engine and Docker Compose on the VPS. If using TLS, point a domain's DNS A/AAAA records at the server and open ports `80` and `443`.

## Install Files

Use a source checkout:

```sh
git clone https://github.com/CoreBunch/Instatic.git
cd instatic
```

For plain SQLite without TLS, source builds use `compose.prod.yml`, `compose.sqlite.yml`, and `compose.build.yml`. Image-pull installs use only `compose.prod.yml` and `compose.sqlite.yml`, but they still need the Compose files from a checkout or release bundle.

## SQLite Install

For reversible server secrets such as AI credentials, plugin secret settings, and TOTP MFA seeds, copy the env template and set `INSTATIC_SECRET_KEY` first:

```sh
cp .env.production.example .env
bun run scripts/generate-secret-key.ts
```

Paste the printed key into `.env` as `INSTATIC_SECRET_KEY`.

Run:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d --build
```

This starts one `app` container. `compose.sqlite.yml` disables the Postgres service and sets:

```txt
DATABASE_URL=sqlite:/app/data/cms.db
```

Persistent data:

| Volume | Mount path | Contents |
|---|---|---|
| `data` | `/app/data` | SQLite database |
| `uploads` | `/app/uploads` | Media, fonts, plugins, published artefacts |

Open:

```txt
http://server-ip:3001/admin
```

The first visit creates the site and admin account.

## Postgres Install

Copy the env template:

```sh
cp .env.production.example .env
```

Edit `.env` and set a real password:

```txt
POSTGRES_PASSWORD=replace-with-a-long-random-password
INSTATIC_SECRET_KEY=replace-with-output-of-generate-secret-key
```

Generate one with:

```sh
openssl rand -hex 24
```

Start the stack:

```sh
docker compose -f compose.prod.yml -f compose.build.yml up -d --build
```

This starts `app` and `postgres`. `compose.prod.yml` sets the app's `DATABASE_URL` to the bundled Postgres service:

```txt
postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
```

Persistent data:

| Volume | Mount path | Contents |
|---|---|---|
| `postgres_data` | `/var/lib/postgresql/data` | Postgres data directory |
| `uploads` | `/app/uploads` | Media, fonts, plugins, published artefacts |

## HTTPS

Add `compose.tls.yml` when the VPS has a public domain. Set these in `.env`:

```txt
DOMAIN=cms.example.com
LETSENCRYPT_EMAIL=ops@example.com
```

Run SQLite + TLS:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.tls.yml -f compose.build.yml up -d --build
```

Run Postgres + TLS:

```sh
docker compose -f compose.prod.yml -f compose.tls.yml -f compose.build.yml up -d --build
```

See [tls-caddy.md](tls-caddy.md) for the Caddy details.

## Operations

Check status:

```sh
docker compose -f compose.prod.yml ps
curl http://localhost:3001/health
```

View logs:

```sh
docker compose -f compose.prod.yml logs -f app
docker compose -f compose.prod.yml logs -f postgres   # Postgres installs only
```

Update a source-build install:

```sh
git pull
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d --build
```

For Postgres source-build installs, omit `compose.sqlite.yml`:

```sh
git pull
docker compose -f compose.prod.yml -f compose.build.yml up -d --build
```

Update an image-pull install:

```sh
docker compose -f compose.prod.yml pull app
docker compose -f compose.prod.yml up -d
```

SQLite image-pull installs include the SQLite override:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml pull app
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

## Without Docker (Direct Bun Install)

The CMS runs directly on the host without Docker. From a source checkout:

```sh
bun install
bun run build
DATABASE_URL=sqlite:./data/cms.db \
  STATIC_DIR=./dist \
  UPLOADS_DIR=./uploads \
  INSTATIC_SECRET_KEY=replace-with-output-of-generate-secret-key \
  TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128 \
  PORT=3001 \
  bun run server/index.ts
```

Replace `DATABASE_URL` with a Postgres connection string for Postgres mode. `STATIC_DIR` must point at the built admin SPA (`dist/` after `bun run build`).

Wrap the command in a process supervisor (systemd, pm2, supervisord) for auto-restart on crash and on server boot. Put an HTTPS-capable reverse proxy (Caddy, Nginx, Cloudflare Tunnel) in front for TLS. Set `TRUSTED_PROXY_CIDRS` only to the socket peers that can reach the Bun process as trusted proxies; leave it empty if the app is directly exposed.

## Data Safety

`docker compose down` stops containers and keeps named volumes.

`docker compose down -v` deletes named volumes. For Instatic that means deleting the CMS database and uploaded media. Use it only when intentionally wiping the install.

Backups are covered in [backup-restore.md](backup-restore.md).

## Related

- [deployment/README.md](README.md) — deployment overview
- [docker-image.md](docker-image.md) — generic Docker image contract
- [tls-caddy.md](tls-caddy.md) — HTTPS overlay
- [backup-restore.md](backup-restore.md) — backup and restore procedures
- `compose.prod.yml` — production Compose base
- `compose.sqlite.yml` — SQLite override
- `compose.tls.yml` — Caddy TLS override
