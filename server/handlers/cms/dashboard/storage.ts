/**
 * Storage widget reader — per-category byte counts (image / video /
 * document media + plugins-on-disk + database) plus the dialect label
 * the widget surfaces in its caption.
 *
 * Media is split into three sub-categories with a single SQL pass that
 * sums conditionally per mime-type bucket. Anything that isn't
 * `image/*` or `video/*` (audio, application/*, text/*, fonts, rows
 * with NULL mime_type) lands in `documentBytes` so the three counters
 * are guaranteed to sum back to the original media total.
 *
 * `case when ... then size_bytes else 0 end` is portable across PG and
 * SQLite — both dialects support standard SQL `CASE` and the `LIKE`
 * pattern match.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DbClient } from '../../../db/client'
import { isSqliteUrl, parseSqlitePath } from '../../../db'
import type { CmsHandlerOptions } from '../shared'
import { coerceBytes } from '../../../repositories/dashboard'
import type { StorageStats } from './types'

export async function readStorageStats(
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<StorageStats> {
  const [mediaResult, pluginBytes, databaseBytes] = await Promise.all([
    db<{
      image_bytes: number | string | null
      video_bytes: number | string | null
      document_bytes: number | string | null
    }>`
      select
        coalesce(sum(case when mime_type like 'image/%' then size_bytes else 0 end), 0) as image_bytes,
        coalesce(sum(case when mime_type like 'video/%' then size_bytes else 0 end), 0) as video_bytes,
        coalesce(sum(case when mime_type not like 'image/%' and mime_type not like 'video/%' then size_bytes
                          when mime_type is null then size_bytes
                          else 0 end), 0) as document_bytes
      from media_assets
      where deleted_at is null
    `,
    options.uploadsDir
      ? sumDirectoryBytes(join(options.uploadsDir, 'plugins'))
      : Promise.resolve(0),
    readDatabaseBytes(db, options.databaseUrl),
  ])

  const totals = mediaResult.rows[0]
  const imageBytes = coerceBytes(totals?.image_bytes)
  const videoBytes = coerceBytes(totals?.video_bytes)
  const documentBytes = coerceBytes(totals?.document_bytes)

  return {
    imageBytes,
    videoBytes,
    documentBytes,
    pluginBytes,
    databaseBytes,
    totalBytes: imageBytes + videoBytes + documentBytes + pluginBytes + databaseBytes,
    dialect: db.dialect,
  }
}

/**
 * Recursively sum the byte sizes of every regular file under `dir`.
 *
 * Returns `0` when the directory does not exist (e.g. a fresh install
 * with no plugins installed yet). Symlinks are resolved via the default
 * `stat` behaviour — that's fine for the plugin asset tree which is
 * always a regular directory tree the server writes itself. Any per-
 * entry error (a file vanishing between `readdir` and `stat`, a
 * permission gap) is swallowed for that entry and counted as zero; the
 * dashboard widget is a usage estimate, not a forensic audit.
 */
async function sumDirectoryBytes(dir: string): Promise<number> {
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[]
  try {
    const list = await readdir(dir, { withFileTypes: true })
    entries = list.map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
    }))
  } catch (err) {
    if (isFsNotFound(err)) return 0
    console.error('[dashboard:storage] readdir failed for', dir, err)
    return 0
  }

  let total = 0
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory) {
      total += await sumDirectoryBytes(full)
    } else if (entry.isFile) {
      try {
        const s = await stat(full)
        total += s.size
      } catch (err) {
        if (!isFsNotFound(err)) {
          console.error('[dashboard:storage] stat failed for', full, err)
        }
      }
    }
  }
  return total
}

/** True for Node-style filesystem "no such file or directory" errors. */
function isFsNotFound(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT'
}

/**
 * Compute the byte size of the underlying database.
 *
 *   • SQLite: stat the file at the parsed DATABASE_URL path. WAL +
 *     shared-memory sidecars (`-wal`, `-shm`) are added when present
 *     because they hold uncommitted page data and matter for the "what
 *     is this database really costing on disk?" answer the widget is
 *     trying to give. Missing sidecars (WAL not yet rotated, no live
 *     connections) silently contribute zero.
 *   • Postgres: `pg_database_size(current_database())` — the canonical
 *     PG function for this. Dialect-aware because there is no portable
 *     equivalent; SQLite has no `pg_database_size` and Postgres has no
 *     on-disk file the host process can stat directly.
 *
 * Returns `0` when no measurement is possible (missing config, stat
 * error). The dashboard would still render — the segment just contributes
 * zero to the breakdown bar.
 */
async function readDatabaseBytes(
  db: DbClient,
  databaseUrl: string | undefined,
): Promise<number> {
  if (db.dialect === 'postgres') {
    try {
      const { rows } = await db<{ size: number | string | null }>`
        select pg_database_size(current_database()) as size
      `
      return coerceBytes(rows[0]?.size)
    } catch (err) {
      console.error('[dashboard:storage] pg_database_size failed:', err)
      return 0
    }
  }

  // SQLite: stat the main file + WAL/SHM sidecars when present.
  if (!databaseUrl || !isSqliteUrl(databaseUrl)) return 0
  const path = parseSqlitePath(databaseUrl)
  const sidecars = [path, `${path}-wal`, `${path}-shm`]
  let total = 0
  for (const p of sidecars) {
    try {
      const s = await stat(p)
      total += s.size
    } catch (err) {
      // ENOENT for sidecars is the common case; only log unexpected errors.
      if (!isFsNotFound(err)) {
        console.error('[dashboard:storage] stat failed for', p, err)
      }
    }
  }
  return total
}
