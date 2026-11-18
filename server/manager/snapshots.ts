/**
 * Database snapshots: consistent copies of the live database kept in
 * `<manager dir>/snapshots/<version>-<unixts>.db`. The file name is the id.
 * A snapshot is always a SQLite file, whichever engine the instance runs on
 * (a Postgres instance writes one through `postgresBridge`), so a snapshot
 * can be restored on, or pulled to, either engine. It holds the database
 * only, never uploads, matching the snapshots Instatic Desktop takes of
 * local sites.
 */
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SERVER_VERSION } from '../version'
import type { FileHashCache } from './fsUtil'
import { restoreStagingPath, snapshotsDir } from './paths'

export interface SnapshotEntry {
  id: string
  version: string
  createdAt: string
  sizeBytes: number
  sha256: string
}

const SNAPSHOT_ID_RE = /^([0-9A-Za-z.+_-]+)-(\d{1,12})\.db$/

export function parseSnapshotId(id: string): { version: string; unixSeconds: number } | null {
  const match = SNAPSHOT_ID_RE.exec(id)
  if (!match?.[1] || !match[2]) return null
  return { version: match[1], unixSeconds: Number(match[2]) }
}

async function describe(managerDir: string, id: string, hashes: FileHashCache): Promise<SnapshotEntry | null> {
  const parsed = parseSnapshotId(id)
  if (!parsed) return null
  const path = join(snapshotsDir(managerDir), id)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return null
  return {
    id,
    version: parsed.version,
    createdAt: new Date(parsed.unixSeconds * 1000).toISOString(),
    sizeBytes: info.size,
    sha256: await hashes.hash(path, info.size, info.mtimeMs),
  }
}

export async function listSnapshots(managerDir: string, hashes: FileHashCache): Promise<SnapshotEntry[]> {
  const names = await readdir(snapshotsDir(managerDir)).catch(() => [])
  const entries: SnapshotEntry[] = []
  for (const name of names) {
    const entry = await describe(managerDir, name, hashes)
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return entries
}

export async function getSnapshot(managerDir: string, id: string, hashes: FileHashCache): Promise<SnapshotEntry | null> {
  return describe(managerDir, id, hashes)
}

export function snapshotPath(managerDir: string, id: string): string {
  return join(snapshotsDir(managerDir), id)
}

/** `writeCopy` writes a consistent copy of the live database to the given path. */
export async function createSnapshot(
  managerDir: string,
  writeCopy: (dest: string) => void | Promise<void>,
  hashes: FileHashCache,
): Promise<SnapshotEntry> {
  const dir = snapshotsDir(managerDir)
  await mkdir(dir, { recursive: true })
  // Two snapshots inside the same second would collide on the name.
  let unixSeconds = Math.floor(Date.now() / 1000)
  let id = `${SERVER_VERSION}-${unixSeconds}.db`
  while (await stat(join(dir, id)).catch(() => null)) {
    unixSeconds += 1
    id = `${SERVER_VERSION}-${unixSeconds}.db`
  }
  await writeCopy(join(dir, id))
  const entry = await describe(managerDir, id, hashes)
  if (!entry) throw new Error('[manager] the snapshot file is missing after it was written')
  return entry
}

export async function deleteSnapshot(managerDir: string, id: string): Promise<void> {
  await rm(snapshotPath(managerDir, id), { force: true })
}

/** Copy a snapshot to the restore staging path; returns that path. */
export async function stageSnapshotRestore(managerDir: string, id: string): Promise<string> {
  const staged = restoreStagingPath(managerDir)
  await rm(staged, { force: true })
  await copyFile(snapshotPath(managerDir, id), staged)
  return staged
}
