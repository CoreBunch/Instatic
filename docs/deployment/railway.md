# Railway Deployment

This guide defines the Railway image-source configuration for Instatic.

Railway is the simplest managed target for Instatic because it can run the published Docker image, inject a public HTTP port, attach a persistent volume, provision Postgres in the same project, and automatically apply image updates during a maintenance window.

---

## TL;DR

| Template | Database | App volume | `DATABASE_URL` |
|---|---|---|---|
| SQLite | SQLite file in the app volume | `/app/storage` | `sqlite:/app/storage/data/cms.db` |
| Postgres | Railway Postgres service | `/app/storage` for uploads only | `${{Postgres.DATABASE_URL}}` |

Both templates use:

```txt
Image=ghcr.io/corebunch/instatic:0.0.11
PORT=8080
UPLOADS_DIR=/app/storage/uploads
STATIC_DIR=/app/dist
INSTATIC_SECRET_KEY=${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}}=
PUBLIC_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
RAILWAY_RUN_UID=0
```

Configure the app service health check path as `/health`. If Railway asks which port the app listens on when generating a public URL, use the same value as `PORT`.

## App Service

Use a Docker image source for production installs:

```txt
ghcr.io/corebunch/instatic:0.0.11
```

The image already runs:

```sh
bun run server/index.ts
```

Do not add a separate migration command. `server/index.ts` creates the DB client from `DATABASE_URL` and runs the matching migrations before the HTTP server starts.

Recommended service settings:

| Setting | Value |
|---|---|
| Source | Docker image |
| Image | `ghcr.io/corebunch/instatic:0.0.11` |
| Public networking | HTTP enabled |
| Target port | `8080` |
| Healthcheck path | `/health` |
| Volume mount path | `/app/storage` |

Railway volumes mount at runtime, not build time. Instatic only writes runtime data there, so the published image stays unchanged across installs.

Railway mounts volumes as `root`. The Instatic image normally runs as the non-root `bun` user, so Railway templates must set `RAILWAY_RUN_UID=0`; otherwise SQLite and media directory creation fail with `EACCES` under `/app/storage`.

Railway terminates HTTPS before forwarding requests to the container, so the container sees plain HTTP. Instatic derives its CSRF public origin from `PUBLIC_ORIGIN`; the templates set `PUBLIC_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}` so the origin is correct without any proxy trust. The server would auto-detect the same value from `RAILWAY_PUBLIC_DOMAIN` even if `PUBLIC_ORIGIN` were unset, but setting it explicitly is clearer and survives custom-domain edits. If you add a custom domain, append it as a second comma-separated entry, e.g. `PUBLIC_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}},https://www.example.com`.

`TRUSTED_PROXY_CIDRS` is **not** needed for CSRF and is omitted from the templates. It is an optional knob for client-IP attribution only (audit logs, rate-limit keys): set it to Railway's ingress proxy CIDR if you want real client IPs in audit logs, and trust only your actual proxy CIDRs — never `0.0.0.0/0` for a public-facing service.

Railway resolves the `INSTATIC_SECRET_KEY` expression at template deploy time. It generates the base64 32-byte AES key shape Instatic expects, so users do not need to run the local key-generation script for one-click installs. For hand-created Railway services outside the template flow, generate the same value with `bun run scripts/generate-secret-key.ts` and paste it into the variable manually.

Source builds from GitHub remain useful for maintainers testing release candidates, but they are not the production distribution path for user installs. Image-source services avoid creating deployment activity in the public Instatic GitHub repository and can use Railway Image Auto Updates.

## SQLite Template

Use SQLite for the simplest one-service Railway install. Attach one volume to the app service:

```txt
Mount path: /app/storage
```

Set app variables:

```txt
PORT=8080
DATABASE_URL=sqlite:/app/storage/data/cms.db
UPLOADS_DIR=/app/storage/uploads
STATIC_DIR=/app/dist
INSTATIC_SECRET_KEY=${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}}=
PUBLIC_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
RAILWAY_RUN_UID=0
```

The SQLite adapter creates the parent directory for `/app/storage/data/cms.db` on boot. Media writes create subdirectories under `/app/storage/uploads` as needed.

## Postgres Template

Use Postgres when the site has several admin users, when you want database backups through the DB service, or when you might run more than one app instance later.

Template services:

| Service | Source | Persistent data |
|---|---|---|
| App | Instatic Dockerfile/image | `/app/storage/uploads` on the app volume |
| Postgres | Railway PostgreSQL template | Postgres service volume |

Attach one volume to the app service:

```txt
Mount path: /app/storage
```

Set app variables:

```txt
PORT=8080
DATABASE_URL=${{Postgres.DATABASE_URL}}
UPLOADS_DIR=/app/storage/uploads
STATIC_DIR=/app/dist
INSTATIC_SECRET_KEY=${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}}=
PUBLIC_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
RAILWAY_RUN_UID=0
```

The `Postgres` prefix is the Railway service name. If the database service is renamed, update the reference to match, for example `${{instatic-postgres.DATABASE_URL}}`.

Use `DATABASE_URL`, not `DATABASE_PUBLIC_URL`, for app-to-database traffic inside the same Railway project. `DATABASE_PUBLIC_URL` goes through Railway's public TCP proxy and is for external clients such as local admin tools.

## Backups

Back up both data stores:

- SQLite template: back up the app volume mounted at `/app/storage`; it contains both `data/cms.db` and `uploads/`.
- Postgres template: back up the Postgres service volume/database and the app volume mounted at `/app/storage`; the app volume contains uploaded media, fonts, plugin packages, and published artefacts.

Railway volume backups apply to mounted volumes. For Postgres, use Railway's database backup/PITR tooling when enabled, or add a `pg_dump` backup service for off-platform dumps.

## Updates

Enable Railway Image Auto Updates on the app service:

- Use `ghcr.io/corebunch/instatic:latest` when you want the service to redeploy whenever the `latest` tag moves.
- Use a semver tag like `ghcr.io/corebunch/instatic:0.0.11` when you want Railway to stage matching patch or minor updates according to the service's auto-update preference.

Set a maintenance window before enabling automatic updates on sites with attached volumes.

## Troubleshooting

| Symptom | Check |
|---|---|
| Public URL shows service unavailable | `PORT` and the public target port must match. The template uses `8080`. |
| Deploy health check fails | Healthcheck path must be `/health`; the app must listen on `PORT`. |
| SQLite data disappears after redeploy | `DATABASE_URL` must point under the mounted volume, e.g. `/app/storage/data/cms.db`. |
| Uploaded files disappear after redeploy | `UPLOADS_DIR` must point under the mounted volume, e.g. `/app/storage/uploads`. |
| App logs show `EACCES: permission denied, mkdir '/app/storage/...'` | Set `RAILWAY_RUN_UID=0`; Railway mounts volumes as `root` and the image otherwise runs as non-root `bun`. |
| First-run setup or login returns `Forbidden: invalid origin` | Confirm `PUBLIC_ORIGIN` matches the public URL you opened. Templates set `PUBLIC_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}`; if you front the app with a custom domain, append it as a second comma-separated entry. |
| Postgres app cannot connect | `DATABASE_URL` must reference the Postgres service's internal `DATABASE_URL`, not a copied local URL. |
| Adding an AI provider credential or enabling TOTP MFA returns 500 | Confirm `INSTATIC_SECRET_KEY` exists and has not been rotated. One-click templates generate it automatically; hand-created services can generate it with `bun run scripts/generate-secret-key.ts`. |
| Deployments appear in the Instatic GitHub repo | The service is connected to GitHub source. Change the service source to the published Docker image. |

## Related

- [deployment/README.md](README.md) — deployment overview
- [backup-restore.md](backup-restore.md) — backup rules
- `server/config.ts` — runtime env parsing
- `server/db/index.ts` — database URL detection
- `Dockerfile` — production image
- Railway docs: [PostgreSQL](https://docs.railway.com/databases/postgresql/), [template variable functions](https://docs.railway.com/templates/create#template-variable-functions), [public networking headers](https://docs.railway.com/networking/public-networking/specs-and-limits), [volumes](https://docs.railway.com/volumes/reference), [health checks](https://docs.railway.com/reference/healthchecks)
