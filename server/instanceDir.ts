/**
 * Where the server keeps state that must outlive a restart but must never be
 * served: the Manager API working directory and the runtime package cache.
 *
 * It is the directory that holds the SQLite database, so it is on persistent
 * storage wherever the database is. Postgres instances have no database file;
 * they use the parent of the uploads directory instead, which is persistent
 * when the volume holds that parent (the `/app/storage` layout of the Railway
 * and Render templates) and not when the volume is mounted on the uploads
 * directory itself.
 *
 * It is never inside `UPLOADS_DIR`: that tree is served publicly at
 * `/uploads/*` and is what a Manager API transfer lists and copies.
 */
import { dirname, resolve } from 'node:path'
import { isSqliteUrl, parseSqlitePath } from './db'

export function instanceStateDir(uploadsDir: string, databaseUrl: string): string {
  return isSqliteUrl(databaseUrl)
    ? dirname(resolve(parseSqlitePath(databaseUrl)))
    : dirname(resolve(uploadsDir))
}
