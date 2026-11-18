/**
 * Pending restore: how a snapshot restore or a transfer takes effect.
 *
 * The running server holds the database open and caches state in memory, so
 * data is never swapped under a live process. A restore is instead STAGED:
 * the new database (and, for a transfer, new upload files) sit in the manager
 * directory next to a `pending.json` marker, the process exits with
 * `MANAGER_RESTART_EXIT_CODE`, and the next boot calls
 * {@link applyPendingRestore} BEFORE the database is opened.
 *
 * Rules the apply step holds to:
 *
 *  - The marker says WHAT to do, never WHERE. Every path is derived from the
 *    configured directories at apply time, so a marker cannot point the
 *    process (which may run as root) at arbitrary files.
 *  - Nothing in the uploads tree is touched until the database swap has been
 *    recorded as done. A marker whose staged database is missing is discarded
 *    untouched, never "resumed" into deleting uploads.
 *  - Every step is idempotent and progress is recorded in the marker, so a
 *    crash at any point resumes on the next boot. That includes the database
 *    swap itself: the new file moves staged -> `<db>.incoming` -> live, and
 *    the marker records when that swap has begun.
 *  - On Postgres the database step is one transaction instead of a file
 *    swap: the staged SQLite file is imported by `postgresBridge`, and the
 *    undo copy is the previous database written out as a SQLite file.
 *  - A failure never aborts boot. It is recorded for `/info`, the marker
 *    stays, and the server starts: an unreachable server in a restart loop
 *    cannot be repaired by its manager, a reachable one can.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import { checkpointDatabase, sqlitePathOf } from './database'
import { exportPostgresToSqlite, importSqliteIntoPostgres } from './postgresBridge'
import { managerLayoutProblem } from './config'
import { isSafeRelativePath, moveFile, passesThroughSymlink, pruneEmptyDirs, resolveRelative, walkFiles } from './fsUtil'
import {
  pendingMarkerPath,
  postgresPreRestorePath,
  preRestorePath,
  restoreErrorPath,
  restoreStagingPath,
  stagedDatabasePath,
  stagedFilesDir,
  transferDir,
} from './paths'

const PendingRestoreSchema = Type.Object({
  kind: Type.Union([Type.Literal('snapshot'), Type.Literal('transfer')]),
  createdAt: Type.String(),
  /**
   * Set once the new database sits beside the live one and the swap is about
   * to begin. From here on, a missing intermediate file means the swap
   * already finished, not that there was nothing to swap.
   */
  databaseSwapStarted: Type.Optional(Type.Boolean()),
  /**
   * Postgres only: set once the undo copy of the previous database has been
   * taken (or found impossible). A run killed right after the import must
   * not take it again, or the undo copy would hold the restored data.
   */
  undoCopyTaken: Type.Optional(Type.Boolean()),
  /** Set once the staged database has become the live one. */
  databaseApplied: Type.Boolean(),
  /**
   * Transfers only: every relative upload path that must exist afterwards.
   * Anything else under the uploads root is removed.
   */
  keep: Type.Optional(Type.Array(Type.String())),
})

export type PendingRestore = Static<typeof PendingRestoreSchema>

export function hasPendingRestore(managerDir: string): boolean {
  return existsSync(pendingMarkerPath(managerDir))
}

export async function writePendingRestore(managerDir: string, pending: PendingRestore): Promise<void> {
  await mkdir(managerDir, { recursive: true })
  const marker = pendingMarkerPath(managerDir)
  // Write-then-rename so a crash never leaves a truncated marker behind.
  await writeFile(`${marker}.tmp`, `${JSON.stringify(pending)}\n`)
  await rename(`${marker}.tmp`, marker)
}

async function readPendingRestore(managerDir: string): Promise<PendingRestore | null> {
  try {
    const parsed = safeParseValue(PendingRestoreSchema, JSON.parse(await readFile(pendingMarkerPath(managerDir), 'utf-8')))
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

/** Drop a staged restore and everything staged for it. Live data is untouched. */
export async function discardPendingRestore(managerDir: string): Promise<void> {
  await rm(pendingMarkerPath(managerDir), { force: true })
  await rm(restoreStagingPath(managerDir), { force: true })
  await rm(transferDir(managerDir), { recursive: true, force: true })
  await rm(restoreErrorPath(managerDir), { force: true })
}

/** The recorded reason the last apply did not finish, or null. */
export async function readRestoreError(managerDir: string): Promise<string | null> {
  try {
    const text = (await readFile(restoreErrorPath(managerDir), 'utf-8')).trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

export interface ApplyPendingOptions {
  managerDir: string
  databaseUrl: string
  uploadsDir: string
}

export type ApplyOutcome =
  | { status: 'none' }
  | { status: 'applied'; kind: PendingRestore['kind'] }
  | { status: 'discarded'; reason: string }
  | { status: 'failed'; reason: string }

/**
 * Apply a staged restore if one exists. Never throws: a failure is recorded
 * (see {@link readRestoreError}), the marker stays for the next boot to
 * retry, and the caller continues booting.
 */
export async function applyPendingRestore(options: ApplyPendingOptions): Promise<ApplyOutcome> {
  if (!hasPendingRestore(options.managerDir)) return { status: 'none' }
  try {
    const outcome = await apply(options)
    if (outcome.status !== 'failed') await rm(restoreErrorPath(options.managerDir), { force: true })
    return outcome
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await writeFile(restoreErrorPath(options.managerDir), `${reason}\n`).catch(() => undefined)
    return { status: 'failed', reason }
  }
}

async function apply(options: ApplyPendingOptions): Promise<ApplyOutcome> {
  const { managerDir, uploadsDir } = options
  const pending = await readPendingRestore(managerDir)
  if (!pending) {
    await discardPendingRestore(managerDir)
    return { status: 'discarded', reason: 'the pending-restore marker was unreadable' }
  }

  const dbPath = sqlitePathOf(options.databaseUrl)
  const layoutProblem = managerLayoutProblem(managerDir, uploadsDir, dbPath)
  if (layoutProblem) {
    await discardPendingRestore(managerDir)
    return { status: 'discarded', reason: layoutProblem }
  }

  // 1. Database.
  if (!pending.databaseApplied && !dbPath) {
    // Postgres: the staged SQLite file is imported in one transaction, so
    // there is no half-swapped state to resume. A run killed before the
    // marker was updated imports the same file again, to the same result;
    // the staged file stays until the marker is dropped in step 3.
    const staged = pending.kind === 'snapshot' ? restoreStagingPath(managerDir) : stagedDatabasePath(managerDir)
    if (!existsSync(staged)) {
      await discardPendingRestore(managerDir)
      return { status: 'discarded', reason: 'the staged database was missing' }
    }
    // The undo copy, taken once per restore. Best effort: a database too
    // broken to read is exactly the one a restore is meant to replace. It is
    // written beside its final name, so a copy that fails halfway never
    // stands in for a whole one, and an older undo copy is not kept as if it
    // belonged to this restore.
    if (!pending.undoCopyTaken) {
      const undo = postgresPreRestorePath(managerDir)
      const incoming = `${undo}.incoming`
      await rm(undo, { force: true })
      try {
        if (await exportPostgresToSqlite(options.databaseUrl, incoming)) await rename(incoming, undo)
      } catch (err) {
        console.warn('[manager] no undo copy was kept:', err instanceof Error ? err.message : err)
      }
      pending.undoCopyTaken = true
      await writePendingRestore(managerDir, pending)
    }
    await importSqliteIntoPostgres(options.databaseUrl, staged)
    pending.databaseApplied = true
    await writePendingRestore(managerDir, pending)
  }
  if (!pending.databaseApplied && dbPath) {
    const staged = pending.kind === 'snapshot' ? restoreStagingPath(managerDir) : stagedDatabasePath(managerDir)
    // The new database travels staged -> `<db>.incoming` -> live. A run that
    // was killed after the first hop left it at `.incoming`, possibly with the
    // live database already set aside, so that file is the restore to finish.
    // Discarding here instead would boot a server whose database is gone.
    const incoming = `${dbPath}.incoming`
    let swapFinished = false
    if (existsSync(staged)) {
      // Bring the new file into the database's own directory first (a copy
      // when the manager directory is another filesystem). Only then are the
      // live file set aside and the new one renamed in: two same-directory
      // renames.
      await rm(incoming, { force: true })
      await moveFile(staged, incoming)
    } else if (!existsSync(incoming)) {
      if (!pending.databaseSwapStarted) {
        // Nothing was swapped and there is nothing to swap in. Touching the
        // uploads now would pair new files with the old database.
        await discardPendingRestore(managerDir)
        return { status: 'discarded', reason: 'the staged database was missing' }
      }
      // The swap began and its intermediate file is gone: the final rename
      // happened and only recording it was cut short.
      swapFinished = true
    }
    if (!swapFinished) {
      pending.databaseSwapStarted = true
      await writePendingRestore(managerDir, pending)
      if (existsSync(dbPath)) {
        // Fold the write-ahead log into the file so the undo copy is complete.
        checkpointDatabase(dbPath)
        await rename(dbPath, preRestorePath(dbPath))
      }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        await rm(`${dbPath}${suffix}`, { force: true })
      }
      await mkdir(dirname(dbPath), { recursive: true })
      await rename(incoming, dbPath)
    }
    pending.databaseApplied = true
    await writePendingRestore(managerDir, pending)
  }

  // 2. Uploads (transfers only). Strays go first, so a staged file never
  // collides with a leftover directory of the same name (or the reverse).
  if (pending.kind === 'transfer' && pending.keep) {
    const keep = new Set(pending.keep.filter(isSafeRelativePath))
    for (const file of await walkFiles(uploadsDir, managerDir)) {
      if (!keep.has(file.path)) await rm(resolveRelative(uploadsDir, file.path), { force: true })
    }
    await pruneEmptyDirs(uploadsDir, managerDir)
    const stagedDir = stagedFilesDir(managerDir)
    for (const file of await walkFiles(stagedDir)) {
      if (!keep.has(file.path)) continue
      // The manifest was checked for symlinks when the transfer opened, but
      // the tree may have changed since. A path that now passes through one
      // is left unwritten: following it would write outside the uploads root.
      if (await passesThroughSymlink(uploadsDir, file.path)) {
        console.warn(`[manager] skipped ${file.path}: the path passes through a symlink`)
        continue
      }
      const target = resolveRelative(uploadsDir, file.path)
      // A directory where a file must go held only strays; it is gone unless
      // the manifest was inconsistent, which open-time validation rejects.
      await rm(target, { recursive: true, force: true })
      await moveFile(resolveRelative(stagedDir, file.path), target)
    }
  }

  // 3. Done: drop the marker last.
  await rm(transferDir(managerDir), { recursive: true, force: true })
  await rm(restoreStagingPath(managerDir), { force: true })
  await rm(pendingMarkerPath(managerDir), { force: true })
  return { status: 'applied', kind: pending.kind }
}
