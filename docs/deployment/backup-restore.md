# Backup And Restore

A complete backup includes the database and the uploaded media. The procedure depends on whether you're using Postgres or SQLite as the database engine. Pick the matching section below.

The Data workspace's **Export site** ZIP is a portable content backup: it includes editable drafts, separate published versions and shared snapshots, compiled runtime scripts, and selected media. Import with **Replace everything** restores that published state without publishing unfinished edits. Accounts, secrets, installed plugins and server configuration stay outside the ZIP; the database/filesystem procedures below are the full-instance backup path. Cold runtime npm caches require registry access. See [Site Transfer](../features/site-transfer.md) for the exact bundle boundary.

---

## TL;DR

| Deployment | Database backup | Upload backup |
|---|---|---|
| VPS SQLite Compose | Copy `/app/data/cms.db` from the `data` volume | Archive the `uploads` volume |
| VPS Postgres Compose | `pg_dump` from the `postgres` service | Archive the `uploads` volume |
| Railway SQLite | Back up the app volume mounted at `/app/storage` | Same app volume, under `/app/storage/uploads` |
| Railway Postgres | Back up the Postgres service volume/database | Back up the app volume mounted at `/app/storage` |

## Postgres mode — backup

Create a local backup directory:

```sh
mkdir -p backups
```

Load environment values from `.env`:

```sh
set -a
. ./.env
set +a
```

Dump Postgres:

```sh
docker compose -f compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  > "backups/instatic-$(date +%F).sql"
```

Archive uploads:

```sh
docker run --rm \
  -v instatic-prod_uploads:/uploads:ro \
  -v "$PWD/backups:/backup" \
  alpine \
  tar czf "/backup/instatic-uploads-$(date +%F).tgz" -C /uploads .
```

If your Compose project name is not `instatic-prod`, find the actual uploads volume name with `docker volume ls | grep uploads`.

## Postgres mode — restore

Start Postgres before restoring:

```sh
docker compose -f compose.prod.yml up -d postgres
```

Restore the database:

```sh
set -a
. ./.env
set +a

cat backups/instatic-YYYY-MM-DD.sql | docker compose -f compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

Restore uploads:

```sh
docker run --rm \
  -v instatic-prod_uploads:/uploads \
  -v "$PWD/backups:/backup" \
  alpine \
  sh -lc "rm -rf /uploads/* && tar xzf /backup/instatic-uploads-YYYY-MM-DD.tgz -C /uploads"
```

Then start the full stack:

```sh
docker compose -f compose.prod.yml up -d
```

## SQLite mode — backup

The `compose.sqlite.yml` override stores the SQLite database in the `data` named volume at `/app/data/cms.db`. Both ad-hoc and continuous strategies are documented below.

### Ad-hoc snapshot (transactional, safe while the app is running)

Use Bun (already in the app container) and SQLite's online backup API to capture a consistent snapshot without stopping the CMS:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml exec app \
  bun -e "import { Database } from 'bun:sqlite'; const src = new Database('/app/data/cms.db', { readonly: true }); src.exec(\"VACUUM INTO '/app/data/snapshot.db'\");"

docker compose -f compose.prod.yml -f compose.sqlite.yml cp \
  app:/app/data/snapshot.db "./backups/instatic-$(date +%F).db"

docker compose -f compose.prod.yml -f compose.sqlite.yml exec app \
  rm /app/data/snapshot.db
```

`VACUUM INTO` writes a fully consistent copy of the database to a new file — safe to run live, no locking required. Then `docker compose cp` exports it to the host.

Archive uploads exactly the same way as the Postgres mode (the `uploads` volume is shared between the two modes).

### Continuous replication with Litestream (recommended for production)

[Litestream](https://litestream.io) replicates a SQLite database to S3-compatible object storage with second-level RPO. Add a sidecar to the SQLite stack:

```yaml
# Append to compose.sqlite.yml under `services:`
  litestream:
    image: litestream/litestream:latest
    command: replicate
    volumes:
      - data:/data:ro
      - ./litestream.yml:/etc/litestream.yml:ro
    environment:
      LITESTREAM_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?Set S3 access key in .env}
      LITESTREAM_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?Set S3 secret key in .env}
    depends_on:
      - app
    restart: unless-stopped
```

`litestream.yml`:

```yaml
dbs:
  - path: /data/cms.db
    replicas:
      - type: s3
        bucket: my-cms-backups
        path: cms.db
        region: us-east-1
```

With Litestream running, every write to `cms.db` is shipped to S3 within seconds. To restore, point Litestream at the S3 backup before starting the app:

```sh
docker run --rm \
  -v instatic-prod_data:/data \
  -e LITESTREAM_ACCESS_KEY_ID -e LITESTREAM_SECRET_ACCESS_KEY \
  -v "$PWD/litestream.yml:/etc/litestream.yml:ro" \
  litestream/litestream:latest \
  restore -o /data/cms.db /data/cms.db

docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

## SQLite mode — restore (ad-hoc snapshots)

If you took a `VACUUM INTO` snapshot rather than running Litestream:

```sh
# Stop the app first — restoring overwrites the live DB.
docker compose -f compose.prod.yml -f compose.sqlite.yml stop app

# Copy the backup file into the data volume (replacing the existing DB).
docker compose -f compose.prod.yml -f compose.sqlite.yml run --rm --no-deps \
  --entrypoint "" app sh -lc "rm -f /app/data/cms.db /app/data/cms.db-wal /app/data/cms.db-shm"

docker compose -f compose.prod.yml -f compose.sqlite.yml cp \
  "./backups/instatic-YYYY-MM-DD.db" app:/app/data/cms.db

# Start the app — the WAL/SHM sidecar files will be regenerated on next open.
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Restore uploads exactly as in Postgres mode.

## Hosted Provider Backups

When Instatic runs on a provider that offers managed Postgres (Railway Postgres, RDS, Supabase, Render Postgres, Fly Postgres, etc.), the provider's snapshot, volume backup, or point-in-time tooling is the recommended first backup path. Keep an independent `pg_dump` schedule when you need provider-independent recovery.

Railway-specific paths:

| Template | Database path | Upload path |
|---|---|---|
| SQLite | `/app/storage/data/cms.db` | `/app/storage/uploads` |
| Postgres | Railway Postgres service | `/app/storage/uploads` |

For uploads, back up whatever disk or volume is mounted at `UPLOADS_DIR`.

## Related

- [deployment/README.md](README.md) — deployment overview
- [railway.md](railway.md) — Railway volume paths
- [vps.md](vps.md) — VPS Compose volume names
- `compose.prod.yml` — Postgres and uploads volume names
- `compose.sqlite.yml` — SQLite data volume
