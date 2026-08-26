# Coolify Deployment

This guide covers running Instatic on a [Coolify](https://coolify.io) instance using the Compose files at the repository root.

Coolify is a self-hosted PaaS: it manages Docker on your own VPS, runs a Traefik reverse proxy in front of every resource, issues Let's Encrypt certificates, and redeploys on a git push or an image update. Compared with [vps.md](vps.md), you give up hand-running `docker compose` and gain automatic TLS, scheduled backups, and a deploy UI.

---

## TL;DR

| Template | File | Database | Volumes |
|---|---|---|---|
| Postgres | `docker-compose.coolify.yml` | Bundled `postgres:16` service | `instatic-uploads`, `instatic-postgres-data` |
| SQLite | `docker-compose.coolify.sqlite.yml` | SQLite file in a volume | `instatic-uploads`, `instatic-data` |

Both pull `ghcr.io/corebunch/instatic:latest`, expose the app on container port `3001`, and let Coolify generate every secret. There is nothing to fill in by hand before the first deploy — assign a domain and press Deploy.

## Why Coolify Needs Its Own Compose Files

Coolify treats **one** Compose file as the single source of truth. It does not support the `-f base.yml -f override.yml` layering that `compose.prod.yml` + `compose.sqlite.yml` + `compose.tls.yml` rely on, and three of the conventions in those files are actively wrong here:

| VPS Compose | Coolify |
|---|---|
| `ports: "${HOST_PORT}:3001"` publishes on the host | No `ports:` — Traefik routes to the container; publishing a port bypasses the proxy and exposes Postgres |
| `compose.tls.yml` adds a Caddy container for TLS | Coolify's own Traefik terminates TLS and renews certificates |
| `PUBLIC_ORIGIN` derived from a `DOMAIN` env var you set | `PUBLIC_ORIGIN` derived from Coolify's `SERVICE_URL_INSTATIC` magic variable |

The Coolify files also declare no `networks:` block. Coolify creates an isolated bridge network per stack; adding one puts containers on two networks at once and makes Traefik route non-deterministically, which Coolify documents as a cause of intermittent HTTPS outages.

## Which Database?

The database is chosen only by `DATABASE_URL`, and each template hardcodes one. Neither is a default you should feel obliged to change — pick by how many people edit the site at once.

### SQLite — `docker-compose.coolify.sqlite.yml`

Use for a single-site install with one or two admins. This is the simplest thing that works.

**Pros**

- One container. Less RAM, faster cold start, one less thing to fail.
- The whole install is two volumes. No database server to configure, tune, or major-version upgrade.
- No credentials to rotate.

**Cons**

- SQLite serializes writes. Real-time co-editing works, but several people saving heavily at once will contend.
- You cannot scale past a single app container — the database file cannot be shared.
- Backups need care. A file copy taken while the server is writing can be torn, so a scheduled dump should use `sqlite3 .backup` rather than `cp`.

### Postgres — `docker-compose.coolify.yml`

Use when more than a couple of people edit simultaneously, or when you want a database you can dump without quiescing the site.

**Pros**

- Concurrent writers, which matters for a team using real-time co-editing.
- Room to scale the app container later without moving the database first.
- `pg_dump` takes a consistent snapshot of a live database — schedule it as a Coolify Scheduled Task against the `postgres` service. You can also inspect and replicate it with ordinary Postgres tooling.

**Cons**

- A second container: roughly 100–200 MB more RAM.
- A second volume to keep track of.
- Slower first deploy while Postgres initializes.

### Switching Later

Switching is an export/import, not a config change. Both engines run the same migrations and hold the same tables, but nothing copies rows between them automatically — use the CMS transfer export before switching and import afterwards. Plan the choice up front.

## Setup

1. **Create the resource.** In your project, add a resource of type **Docker Compose**. Point it at this repository, or choose the Empty variant and paste the file contents.
2. **Set the Compose file path.** `docker-compose.coolify.yml` or `docker-compose.coolify.sqlite.yml`. The extension must match exactly or Coolify will not load the file. Leave Base Directory as `/`.
3. **Assign the domain to the `instatic` service.** This is the step that matters most — see below. Coolify then issues the certificate and routes `:443` to container port `3001`.
4. **Deploy.** The first deploy pulls the image, runs every migration against the empty database, and reports healthy once `GET /health` answers.
5. **Open `https://your-domain/admin`** and complete the setup wizard. It creates the site, the first owner account, and a starter homepage.

There is no `ADMIN_EMAIL` / `ADMIN_PASSWORD` seeding path — the first admin is always created interactively. Do not add a migration command or a one-shot migration service either: `server/index.ts` runs the migrations itself before the HTTP server starts.

## Domains and `PUBLIC_ORIGIN`

Coolify's Traefik terminates TLS and forwards plain HTTP to the container, and Instatic deliberately never trusts `X-Forwarded-Proto` or `X-Forwarded-Host` to reconstruct its own origin. It reads `PUBLIC_ORIGIN` instead. Both Compose files wire it up automatically:

```yaml
- SERVICE_URL_INSTATIC_3001        # declares the route; Coolify assigns the domain
- PUBLIC_ORIGIN=${SERVICE_URL_INSTATIC}   # reads that domain back, scheme included
```

Because the two are linked, setting a custom domain on the `instatic` service in the Coolify UI updates `PUBLIC_ORIGIN` with it. Nothing else to configure.

Assign the domain to the **`instatic`** service specifically. The Postgres service must never get one.

If `PUBLIC_ORIGIN` is wrong or missing, four things break — and only one of them is loud:

| Symptom | Cause |
|---|---|
| Session cookie is sent without `Secure` | The server believes the request is plain HTTP. Silent — no error anywhere |
| Admin writes rejected with an origin error | CSRF check compares the browser's `Origin` against the wrong expected value |
| Real-time co-editing never connects | The collab WebSocket upgrade runs the same origin guard |
| MCP connectors show `local-only` | OAuth issuer URLs are built from the same origin and must be public HTTPS |

To serve a second origin — say an apex domain alongside `www` — override `PUBLIC_ORIGIN` in the Coolify UI with a comma-separated list.

## `INSTATIC_SECRET_KEY`

The image runs with `NODE_ENV=production`, where the server **refuses to boot** without this key. Both files generate it with Coolify's `SERVICE_REALBASE64_32_INSTATIC` magic variable, which produces exactly the base64 32-byte AES key Instatic expects.

It encrypts reversible server secrets: AI provider credentials, plugin secret settings, and MFA TOTP seeds.

> **Do not edit or clear this value after the first deploy.** Coolify generates it once and keeps it stable across redeploys. Changing it strands every value already encrypted under the old key — AI credentials must be re-entered and MFA re-enrolled.

Record it alongside your backups. Restoring a database without the matching key leaves those secrets unreadable.

## Persistent Storage

Both templates use **named volumes**, and Coolify appends the resource UUID to each so they never collide with another stack.

| Volume | Mount | Contents |
|---|---|---|
| `instatic-uploads` | `/app/uploads` | Media originals and variants, fonts, plugin packages, published static artefacts under `published/current` |
| `instatic-postgres-data` | `/var/lib/postgresql/data` | Postgres data directory (Postgres template) |
| `instatic-data` | `/app/data` | SQLite database file (SQLite template) |

> **Use named volumes, not bind mounts.** The image runs as the non-root `bun` user. A Coolify bind mount to a host path is created root-owned, and every write fails with `EACCES`. The mount paths above are created and chowned inside the `Dockerfile` before it drops privileges, so named volumes mounted there inherit the right ownership. This is also why neither template uses the single-volume `/app/storage` layout that the Railway and Render templates use — those platforms allow only one disk and work around the ownership problem with `RAILWAY_RUN_UID=0`.

Back up the database *and* `instatic-uploads`; neither is recoverable from the other. See [backup-restore.md](backup-restore.md).

## Proxy Behavior Worth Knowing

- **WebSockets.** Real-time co-editing uses a WebSocket at `/admin/api/cms/site-socket`. Traefik forwards `Upgrade` / `Connection` headers by default, and the app keeps the connection alive with its own ping/pong frames, so no extra configuration is needed. If co-editing drops repeatedly, suspect `PUBLIC_ORIGIN` before the proxy — the upgrade runs the origin guard.
- **Long responses.** The server disables Bun's idle timeout because the AI endpoints stream NDJSON for as long as a model keeps working. Do not put a short response timeout in front of it.
- **Body sizes.** Media uploads accept up to 50 MiB and archive imports up to 256 MiB. Traefik imposes no limit of its own, but a CDN or WAF in front of Coolify might.
- **Caching.** Published assets are content-hashed and already ship `cache-control: public, max-age=31536000, immutable`, so a CDN can be layered on with no extra configuration.
- **`TRUSTED_PROXY_CIDRS`** defaults to the Docker bridge range `172.16.0.0/12`. It affects only client-IP attribution in audit logs and rate-limit keys — it plays no part in CSRF. Trusting that range is safe here because no host port is published, so nothing but Coolify's proxy can reach the container. Override it if your Coolify network uses a different range.

## Updating

The templates track `ghcr.io/corebunch/instatic:latest`. Redeploy in Coolify to pull the current image; migrations run automatically on the next boot.

Pin a version for predictable upgrades by setting `INSTATIC_IMAGE` in the Coolify UI:

```txt
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:0.0.16
```

## ARM64 Hosts

The published image is built for `linux/amd64` only. On an ARM VPS, build from source instead: add a `build` block pointing at the repository `Dockerfile` and deploy with Coolify's Docker Compose build pack.

```yaml
services:
  instatic:
    build:
      context: .
      dockerfile: Dockerfile
    image: instatic:local
```

## Related

- [README.md](README.md) — deployment index and the shared runtime contract
- [vps.md](vps.md) — hand-run Docker Compose on a plain VPS
- [docker-image.md](docker-image.md) — the image's environment-variable contract
- [backup-restore.md](backup-restore.md) — backing up the database and uploads
