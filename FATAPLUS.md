# FATAPLUS Website — Instatic CMS

This is the FATAPLUS-specific deployment of [Instatic CMS](https://github.com/CoreBunch/Instatic).

## Architecture

- **CMS**: Instatic (self-hosted, Docker, SQLite mode)
- **VPS**: vps-tailscale (Contabo, 144.91.96.120, Tailscale: 100.112.45.36)
- **Domain**: builder.nexio.work (CF DNS → Caddy proxy → Instatic on :3001)
- **Published site**: fata.plus (CF Pages worker, pulls from Instatic publish output)
- **Backups**: Cloudflare R2 (`fataplus-cms` bucket), daily via GitHub Actions

## Repository Structure

This repo tracks the upstream Instatic CMS with FATAPLUS-specific overlays:

- `compose.override.yml` — FATAPLUS env config (domain, proxy settings)
- `.env.fataplus.example` — Environment template
- `scripts/backup-instatic-to-r2.sh` — R2 backup script
- `.github/workflows/deploy.yml` — CI/CD: deploy on push to main
- `.github/workflows/backup.yml` — CI/CD: daily R2 backup at 03:00 UTC

## Syncing with Upstream

```bash
git fetch upstream
git merge upstream/main
# Resolve conflicts in compose.override.yml if any
git push origin main
```

## Deployment

Push to `main` triggers automatic deploy:
1. GitHub Actions runner joins Tailscale tailnet
2. SSH to VPS → git pull → docker compose up --build
3. Health check on :3001/health

Manual deploy:
```bash
ssh vps-tailscale
cd /root/workspace/instatic
git pull origin main
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.override.yml -f compose.build.yml up -d --build
```

## Backup

Daily at 03:00 UTC (06:00 EAT). Manual trigger via GitHub Actions → "Backup to R2" → Run workflow.

Local restore:
```bash
# Download from R2
npx wrangler r2 object get fataplus-cms/instatic/cms-YYYYMMDD-HHMMSS.db --remote
# Stop app, restore DB, restart
docker compose -f compose.prod.yml -f compose.sqlite.yml stop app
docker compose -f compose.prod.yml -f compose.sqlite.yml run --rm --no-deps --entrypoint "" app sh -lc "rm -f /app/data/cms.db*"
docker compose -f compose.prod.yml -f compose.sqlite.yml cp ./cms-YYYYMMDD-HHMMSS.db app:/app/data/cms.db
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```
