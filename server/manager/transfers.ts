/**
 * Transfers: the write side of the Manager API. A transfer uploads a new
 * database and the upload files the instance should end up with into
 * `<manager dir>/transfer/`, without touching anything live. Commit verifies
 * every byte and stages the swap for the next boot (see `pending.ts`).
 *
 * One transfer exists at a time. Its state is persisted so a manager that
 * lost its own state, or a server that restarted mid-upload, can resume.
 */
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import { TransferFileSchema, type OpenTransferBody } from './schema'
import { resolveRelative, sha256File, walkFiles, type FileHashCache } from './fsUtil'
import { stagedDatabasePath, stagedFilesDir, transferDir, transferStatePath } from './paths'

export const TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000

const TransferStateSchema = Type.Object({
  id: Type.String(),
  createdAt: Type.String(),
  lastActivityAt: Type.String(),
  committed: Type.Boolean(),
  database: Type.Object({ sizeBytes: Type.Integer(), sha256: Type.String() }),
  files: Type.Array(TransferFileSchema),
  missing: Type.Array(Type.String()),
})
export type TransferState = Static<typeof TransferStateSchema>

/**
 * The active transfer's state, cached so a chunk upload does not re-read and
 * re-validate a large manifest from disk. Every writer goes through
 * `saveState` / `abortTransfer`, which keep the cache in step.
 */
let cache: { managerDir: string; state: TransferState | null } | null = null

export function transferExpiresAt(state: TransferState): string {
  return new Date(Date.parse(state.lastActivityAt) + TRANSFER_TTL_MS).toISOString()
}

async function saveState(managerDir: string, state: TransferState): Promise<void> {
  const path = transferStatePath(managerDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(state))
  await rename(`${path}.tmp`, path)
  cache = { managerDir, state }
}

/**
 * Forget the cached state so the next read comes from disk. A real restart
 * does this by ending the process; tests that play a restart inside one
 * process call it instead.
 */
export function dropTransferCache(): void {
  cache = null
}

/** The active transfer, or null. An uncommitted transfer past its TTL is discarded. */
export async function loadTransfer(managerDir: string): Promise<TransferState | null> {
  if (cache?.managerDir !== managerDir) {
    cache = { managerDir, state: await readState(managerDir) }
  }
  const state = cache.state
  if (state && !state.committed && Date.parse(state.lastActivityAt) + TRANSFER_TTL_MS < Date.now()) {
    await abortTransfer(managerDir)
    return null
  }
  return state
}

async function readState(managerDir: string): Promise<TransferState | null> {
  let raw: string
  try {
    raw = await readFile(transferStatePath(managerDir), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = safeParseValue(TransferStateSchema, JSON.parse(raw))
    if (parsed.ok) return parsed.value
  } catch {
    // Fall through: an unparseable state file is an abandoned transfer.
  }
  await rm(transferDir(managerDir), { recursive: true, force: true })
  return null
}

export async function abortTransfer(managerDir: string): Promise<void> {
  await rm(transferDir(managerDir), { recursive: true, force: true })
  cache = { managerDir, state: null }
}

/** O(1) lookups over the active transfer's manifest, rebuilt when it changes. */
let index: { state: TransferState; missing: Map<string, number> } | null = null

/** Declared size of a file the server still needs, or null when it is not one. */
export function missingFileSize(state: TransferState, path: string): number | null {
  if (index?.state !== state) {
    const sizes = new Map(state.files.map((file) => [file.path, file.sizeBytes]))
    index = { state, missing: new Map(state.missing.map((entry) => [entry, sizes.get(entry) ?? 0])) }
  }
  return index.missing.get(path) ?? null
}

/**
 * Start a transfer. Files the instance already holds with the same hash are
 * reused in place; only the rest are reported as `missing` and uploaded.
 */
export async function openTransfer(
  managerDir: string,
  uploadsDir: string,
  body: OpenTransferBody,
  hashes: FileHashCache,
): Promise<TransferState> {
  await abortTransfer(managerDir)
  const current = new Map((await walkFiles(uploadsDir, managerDir)).map((file) => [file.path, file]))
  const missing: string[] = []
  for (const file of body.files) {
    const existing = current.get(file.path)
    if (existing && existing.sizeBytes === file.sizeBytes) {
      const sha = await hashes.hash(resolveRelative(uploadsDir, file.path), existing.sizeBytes, existing.mtimeMs)
      if (sha === file.sha256) continue
    }
    missing.push(file.path)
  }
  const now = new Date().toISOString()
  const state: TransferState = {
    id: `tr_${randomBytes(12).toString('hex')}`,
    createdAt: now,
    lastActivityAt: now,
    committed: false,
    database: body.database,
    files: body.files,
    missing,
  }
  await mkdir(stagedFilesDir(managerDir), { recursive: true })
  // An empty file never receives a chunk, so it is staged up front.
  const sizes = new Map(body.files.map((file) => [file.path, file.sizeBytes]))
  for (const path of missing) {
    if (sizes.get(path) !== 0) continue
    const target = resolveRelative(stagedFilesDir(managerDir), path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, '')
  }
  await saveState(managerDir, state)
  return state
}

export async function receivedBytes(path: string): Promise<number> {
  const info = await stat(path).catch(() => null)
  return info?.isFile() ? info.size : 0
}

export type AppendResult =
  | { ok: true; receivedBytes: number }
  | { ok: false; reason: 'offset-mismatch' | 'too-large'; receivedBytes: number }

/**
 * Append one chunk at `offset`. The offset must equal what is already on
 * disk, which makes a retried chunk harmless and lets the client resync.
 */
export async function appendChunk(
  managerDir: string,
  state: TransferState,
  target: string,
  declaredSize: number,
  offset: number,
  bytes: Uint8Array,
): Promise<AppendResult> {
  const have = await receivedBytes(target)
  if (offset !== have) return { ok: false, reason: 'offset-mismatch', receivedBytes: have }
  if (have + bytes.byteLength > declaredSize) return { ok: false, reason: 'too-large', receivedBytes: have }
  await mkdir(dirname(target), { recursive: true })
  await appendFile(target, bytes)
  // Persisting activity on every chunk would rewrite a large manifest each
  // time; once a minute is enough to keep the TTL honest. The same object is
  // updated in place so the cached state and the lookup index stay current.
  if (Date.now() - Date.parse(state.lastActivityAt) > 60_000) {
    state.lastActivityAt = new Date().toISOString()
    await saveState(managerDir, state)
  }
  return { ok: true, receivedBytes: have + bytes.byteLength }
}

export interface TransferProgress {
  database: { sizeBytes: number; receivedBytes: number }
  files: { path: string; sizeBytes: number; receivedBytes: number }[]
}

export async function transferProgress(managerDir: string, state: TransferState): Promise<TransferProgress> {
  const sizes = new Map(state.files.map((file) => [file.path, file.sizeBytes]))
  const files = []
  for (const path of state.missing) {
    files.push({
      path,
      sizeBytes: sizes.get(path) ?? 0,
      receivedBytes: await receivedBytes(resolveRelative(stagedFilesDir(managerDir), path)),
    })
  }
  return {
    database: {
      sizeBytes: state.database.sizeBytes,
      receivedBytes: await receivedBytes(stagedDatabasePath(managerDir)),
    },
    files,
  }
}

export interface TransferVerification {
  incomplete: string[]
  mismatched: string[]
}

/** Check every uploaded item against its declared size and SHA-256. */
export async function verifyTransfer(managerDir: string, state: TransferState): Promise<TransferVerification> {
  const incomplete: string[] = []
  const mismatched: string[] = []

  async function check(label: string, path: string, sizeBytes: number, sha256: string): Promise<void> {
    if ((await receivedBytes(path)) !== sizeBytes) {
      incomplete.push(label)
    } else if ((await sha256File(path)) !== sha256) {
      mismatched.push(label)
    }
  }

  await check('database', stagedDatabasePath(managerDir), state.database.sizeBytes, state.database.sha256)
  const byPath = new Map(state.files.map((file) => [file.path, file]))
  for (const path of state.missing) {
    const file = byPath.get(path)
    if (!file) continue
    await check(path, resolveRelative(stagedFilesDir(managerDir), path), file.sizeBytes, file.sha256)
  }
  return { incomplete, mismatched }
}

export async function markCommitted(managerDir: string, state: TransferState): Promise<void> {
  state.committed = true
  state.lastActivityAt = new Date().toISOString()
  await saveState(managerDir, state)
}
