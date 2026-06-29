#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# FATAPLUS Instatic → Cloudflare R2 Backup
#
# Creates a consistent SQLite snapshot (VACUUM INTO, no lock)
# and uploads it + the uploads volume to R2 via wrangler.
#
# Usage: backup-instatic-to-r2.sh
# Env:   CF_API_TOKEN, CF_ACCOUNT_ID, R2_BUCKET
# ============================================================

COMPOSE_DIR="/root/workspace/instatic"
COMPOSE_FILES="-f compose.prod.yml -f compose.sqlite.yml -f compose.override.yml"
DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/tmp/instatic-backup-${DATE}"

: "${CF_API_TOKEN:?CF_API_TOKEN is required}"
: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID is required}"
: "${R2_BUCKET:=fataplus-cms}"

export CLOUDFLARE_API_TOKEN="${CF_API_TOKEN}"
export CLOUDFLARE_ACCOUNT_ID="${CF_ACCOUNT_ID}"

mkdir -p "${BACKUP_DIR}"
cd "${COMPOSE_DIR}"

echo "=== [1/4] SQLite snapshot (VACUUM INTO — safe while running) ==="
docker compose ${COMPOSE_FILES} exec -T app \
  bun -e "import { Database } from 'bun:sqlite'; const src = new Database('/app/data/cms.db', { readonly: true }); src.exec(\"VACUUM INTO '/app/data/snapshot.db'\");"

docker compose ${COMPOSE_FILES} cp app:/app/data/snapshot.db "${BACKUP_DIR}/cms-${DATE}.db"
docker compose ${COMPOSE_FILES} exec -T app rm /app/data/snapshot.db
echo "  → ${BACKUP_DIR}/cms-${DATE}.db ($(du -h "${BACKUP_DIR}/cms-${DATE}.db" | cut -f1))"

echo "=== [2/4] Archive uploads volume ==="
docker run --rm \
  -v instatic-prod_uploads:/uploads:ro \
  -v "${BACKUP_DIR}:/backup" \
  alpine \
  tar czf "/backup/uploads-${DATE}.tgz" -C /uploads . 2>/dev/null
echo "  → ${BACKUP_DIR}/uploads-${DATE}.tgz ($(du -h "${BACKUP_DIR}/uploads-${DATE}.tgz" | cut -f1))"

echo "=== [3/4] Upload to R2 (via wrangler) ==="
for f in "${BACKUP_DIR}/cms-${DATE}.db" "${BACKUP_DIR}/uploads-${DATE}.tgz"; do
  fname=$(basename "$f")
  npx wrangler r2 object put "${R2_BUCKET}/instatic/${fname}" \
    --file "$f" --remote 2>&1 | grep -v "^$" || true
  echo "  → ${R2_BUCKET}/instatic/${fname}"
done

echo "=== [4/4] Cleanup old backups (keep last 30 days) ==="
CUTOFF=$(date -d "30 days ago" +%Y%m%d 2>/dev/null || date -v-30d +%Y%m%d)
npx wrangler r2 object list "${R2_BUCKET}/instatic/" --remote 2>/dev/null | \
  grep -oP '"key":\s*"instatic/[^"]*"' | \
  while read -r line; do
    file_key=$(echo "$line" | grep -oP '"instatic/[^"]*"' | tr -d '"')
    file_date=$(echo "$file_key" | grep -oP '\d{8}' || true)
    if [ -n "$file_date" ] && [ "$file_date" -lt "$CUTOFF" ] 2>/dev/null; then
      npx wrangler r2 object delete "${R2_BUCKET}/${file_key}" --remote 2>/dev/null || true
      echo "  ✗ Deleted ${file_key} (older than 30 days)"
    fi
  done

# Cleanup local temp
rm -rf "${BACKUP_DIR}"

echo ""
echo "✅ Backup complete: ${DATE}"
echo "   R2: ${R2_BUCKET}/instatic/"
