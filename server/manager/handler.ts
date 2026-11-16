/**
 * Manager API dispatcher: `/_instatic/manager/v1/*`.
 *
 * Authenticated by `Authorization: Bearer <INSTATIC_MANAGER_TOKEN>`. Without
 * a configured token, or with a wrong one, the whole namespace answers 404 so
 * the API is invisible on servers that did not opt in. The namespace is
 * exclusive: unknown paths under it never fall through to later routes.
 *
 * Contract: `docs/features/manager-api.md`.
 */
import { timingSafeEqual } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RouteHandler, ServerRuntime, ManagerRuntime } from '../serverRuntime'
import { RequestBodyTooLargeError, jsonResponse, readTextBodyWithLimit, setCookieHeader } from '../http'
import { createSession } from '../auth/sessions'
import { createSessionToken, hashSessionToken, sessionExpiry } from '../auth/tokens'
import { createAuditEvent } from '../repositories/audit'
import { findUserById, markUserLoggedIn } from '../repositories/users'
import { sessionCookie } from '../handlers/cms/session'
import { requestAuditContext } from '../handlers/cms/shared'
import { getSetupStatus } from '../repositories/setup'
import { getMasterKeyFingerprint } from '../secrets/masterKey'
import { SERVER_VERSION } from '../version'
import { safeParseValue, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { MANAGER_API_PREFIX, MANAGER_API_VERSION, MANAGER_NAMESPACE, managerLayoutProblem } from './config'
import { inspectStagedDatabase, revokeStagedSessions, sqlitePathOf, vacuumInto } from './database'
import { exportPostgresToSqlite, postgresDatabaseSize } from './postgresBridge'
import {
  FileHashCache,
  fileRangeResponse,
  freeBytes,
  isSafeRelativePath,
  passesThroughSymlink,
  resolveRelative,
  walkFiles,
} from './fsUtil'
import { exclusive, serialized } from './lock'
import { createLoginLink, findOwnerUserId, redeemLoginLink } from './loginLinks'
import { hashCachePath, restoreStagingPath, stagedDatabasePath, stagedFilesDir } from './paths'
import { discardPendingRestore, hasPendingRestore, readRestoreError, writePendingRestore } from './pending'
import { CommitTransferSchema, OpenTransferSchema, RestoreSnapshotSchema, type OpenTransferBody } from './schema'
import {
  createSnapshot,
  deleteSnapshot,
  getSnapshot,
  listSnapshots,
  parseSnapshotId,
  snapshotPath,
  stageSnapshotRestore,
} from './snapshots'
import {
  TRANSFER_CHUNK_BYTES,
  abortTransfer,
  appendChunk,
  loadTransfer,
  markCommitted,
  missingFileSize,
  openTransfer,
  transferExpiresAt,
  transferProgress,
  verifyTransfer,
  type TransferState,
} from './transfers'

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const LOGIN_LINK_PREFIX = `${MANAGER_API_PREFIX}/login/`
const MAX_OPTIONS_BYTES = 64 * 1024

const hashes = new FileHashCache()

function managerError(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error, message, ...extra }, { status })
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 })
}

function busy(): Response {
  return managerError(409, 'busy', 'Another manager operation is in progress.')
}

function tokenMatches(req: Request, expected: string): boolean {
  const header = req.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  const provided = Buffer.from(header.slice('Bearer '.length))
  const wanted = Buffer.from(expected)
  return provided.length === wanted.length && timingSafeEqual(provided, wanted)
}

/**
 * Read a JSON request body against `schema`.
 *
 *   - `undefined`: the body was empty (the caller applies defaults);
 *   - `null`: the body was present but invalid (the caller answers 400).
 *
 * An invalid body must never fall back to defaults: the defaults of the
 * operations here restart the server and revoke sessions.
 */
async function readJsonBody<T extends TSchema>(req: Request, schema: T, maxBytes: number): Promise<Static<T> | null | undefined> {
  let text: string
  try {
    text = await readTextBodyWithLimit(req, maxBytes)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) throw err
    return null
  }
  if (text.trim().length === 0) return undefined
  try {
    const parsed = safeParseValue(schema, JSON.parse(text))
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

function badBody(): Response {
  return managerError(400, 'bad-request', 'The request body is not valid for this operation.')
}

interface Context {
  req: Request
  url: URL
  runtime: ServerRuntime
  manager: ManagerRuntime
  managerDir: string
  uploadsDir: string
  /** Path of the live SQLite file; null on a Postgres instance. */
  dbPath: string | null
  databaseUrl: string
}

export const tryServeManager: RouteHandler = async (req, runtime, url, pathname) => {
  if (!pathname.startsWith(MANAGER_NAMESPACE)) return null
  const manager = runtime.manager
  if (!manager?.config.token) return notFound()
  // Redeeming a sign-in link is the one request a browser makes here, so it
  // carries no bearer token: the single-use link token is its credential.
  if (req.method === 'GET' && pathname.startsWith(LOGIN_LINK_PREFIX)) {
    return handleRedeemLoginLink(req, runtime, pathname.slice(LOGIN_LINK_PREFIX.length))
  }
  if (!tokenMatches(req, manager.config.token)) return notFound()
  if (pathname !== MANAGER_API_PREFIX && !pathname.startsWith(`${MANAGER_API_PREFIX}/`)) return notFound()

  const ctx: Context = {
    req,
    url,
    runtime,
    manager,
    managerDir: manager.config.dir,
    uploadsDir: resolve(runtime.uploadsDir ?? './uploads'),
    dbPath: runtime.databaseUrl ? sqlitePathOf(runtime.databaseUrl) : null,
    databaseUrl: runtime.databaseUrl ?? '',
  }
  const layoutProblem = managerLayoutProblem(ctx.managerDir, ctx.uploadsDir, ctx.dbPath)
  if (layoutProblem) return managerError(503, 'misconfigured', layoutProblem)

  let segments: string[]
  try {
    segments = pathname.slice(MANAGER_API_PREFIX.length).split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return notFound()
  }
  const [resource, ...rest] = segments
  const method = req.method
  await hashes.load(hashCachePath(ctx.managerDir))

  if (resource === 'info' && rest.length === 0 && method === 'GET') return handleInfo(ctx)

  if (resource === 'login-links' && rest.length === 0 && method === 'POST') return handleCreateLoginLink(ctx)

  if (resource === 'pending-restore' && rest.length === 0 && method === 'DELETE') {
    return serialized(async () => {
      if (!hasPendingRestore(ctx.managerDir)) {
        return managerError(404, 'no-pending-restore', 'No restore is staged.')
      }
      await discardPendingRestore(ctx.managerDir)
      await abortTransfer(ctx.managerDir)
      return jsonResponse({ ok: true })
    })
  }

  if (resource === 'snapshots') {
    if (rest.length === 0 && method === 'GET') {
      const list = await listSnapshots(ctx.managerDir, hashes)
      await hashes.save(hashCachePath(ctx.managerDir))
      return jsonResponse(list)
    }
    if (rest.length === 0 && method === 'POST') return handleCreateSnapshot(ctx)
    const id = rest[0]
    if (!id || !parseSnapshotId(id)) return notFound()
    if (rest.length === 1 && method === 'GET') {
      return (await fileRangeResponse(req, snapshotPath(ctx.managerDir, id))) ?? unknownSnapshot(id)
    }
    if (rest.length === 1 && method === 'DELETE') {
      return serialized(async () => {
        if (!(await getSnapshot(ctx.managerDir, id, hashes))) return unknownSnapshot(id)
        await deleteSnapshot(ctx.managerDir, id)
        return jsonResponse({ ok: true })
      })
    }
    if (rest.length === 2 && rest[1] === 'restore' && method === 'POST') return handleRestoreSnapshot(ctx, id)
    return notFound()
  }

  if (resource === 'files') {
    if (rest.length === 0 && method === 'GET') return handleListFiles(ctx)
    if (rest.length > 0 && method === 'GET') return handleDownloadFile(ctx, rest.join('/'))
    return notFound()
  }

  if (resource === 'transfers') {
    if (rest.length === 0 && method === 'POST') return handleOpenTransfer(ctx)
    const id = rest[0]
    if (!id) return notFound()
    if (rest.length === 1 && method === 'GET') {
      const state = await currentTransfer(ctx, id)
      if (!state) return unknownTransfer()
      return jsonResponse({ ...transferSummary(state), ...(await transferProgress(ctx.managerDir, state)) })
    }
    if (rest.length === 1 && method === 'DELETE') {
      return serialized(async () => {
        const state = await currentTransfer(ctx, id)
        if (!state) return unknownTransfer()
        if (state.committed || hasPendingRestore(ctx.managerDir)) {
          return managerError(409, 'committed', 'The transfer is committed. Cancel it with DELETE /pending-restore.')
        }
        await abortTransfer(ctx.managerDir)
        return jsonResponse({ ok: true })
      })
    }
    if (rest.length === 2 && rest[1] === 'database' && method === 'PUT') return handleChunk(ctx, id, null)
    if (rest.length > 2 && rest[1] === 'files' && method === 'PUT') return handleChunk(ctx, id, rest.slice(2).join('/'))
    if (rest.length === 2 && rest[1] === 'commit' && method === 'POST') return handleCommit(ctx, id)
    return notFound()
  }

  return notFound()
}

/**
 * Mint a one-time sign-in link for the site owner. The manager token already
 * grants full control of the instance (it can replace the whole database),
 * so signing in as the owner adds no privilege; it removes the need to keep
 * a password anywhere.
 */
async function handleCreateLoginLink(ctx: Context): Promise<Response> {
  const ownerId = await findOwnerUserId(ctx.runtime.db)
  if (!ownerId) {
    return managerError(409, 'needs-setup', 'This site has no owner account yet. Finish setup first.')
  }
  const link = createLoginLink(ownerId)
  return jsonResponse({ path: `${LOGIN_LINK_PREFIX}${link.token}`, expiresAt: link.expiresAt.toISOString() }, { status: 201 })
}

/**
 * Spend a sign-in link: start a session for its user and send the browser to
 * the admin. Every failure is the same 404, so a link that was wrong, used
 * or expired cannot be told apart.
 */
async function handleRedeemLoginLink(req: Request, runtime: ServerRuntime, token: string): Promise<Response> {
  const userId = token.length > 0 && token.length <= 128 ? redeemLoginLink(token) : null
  const user = userId ? await findUserById(runtime.db, userId) : null
  if (!user || user.status !== 'active') return notFound()

  const sessionToken = createSessionToken()
  const expiresAt = sessionExpiry()
  await createSession(runtime.db, {
    idHash: await hashSessionToken(sessionToken),
    userId: user.id,
    expiresAt,
    // The manager token outranks a second factor: its holder can already
    // replace the database. The session is therefore fully signed in.
    mfaPassedAt: new Date(),
    ...requestAuditContext(req),
  })
  await markUserLoggedIn(runtime.db, user.id)
  await createAuditEvent(runtime.db, {
    actorUserId: user.id,
    action: 'login.success',
    targetType: 'user',
    targetId: user.id,
    metadata: { method: 'manager-link' },
    ...requestAuditContext(req),
  })

  const response = new Response(null, {
    status: 302,
    headers: {
      location: '/admin',
      'cache-control': 'no-store',
      // The link token is in this request's URL: never pass it on.
      'referrer-policy': 'no-referrer',
    },
  })
  return setCookieHeader(response, sessionCookie(req, sessionToken, expiresAt))
}

/** The active transfer when `id` names it; null for any other id. */
async function currentTransfer(ctx: Context, id: string): Promise<TransferState | null> {
  const state = await loadTransfer(ctx.managerDir)
  return state && state.id === id ? state : null
}

function unknownTransfer(): Response {
  return managerError(404, 'unknown-transfer', 'No such transfer.')
}

function unknownSnapshot(id: string): Response {
  return managerError(404, 'unknown-snapshot', `No such snapshot: ${id}`)
}

/** Size of the live database in bytes, on either engine. */
async function databaseSize(ctx: Context): Promise<number> {
  if (ctx.dbPath) return (await stat(ctx.dbPath).catch(() => null))?.size ?? 0
  return postgresDatabaseSize(ctx.databaseUrl).catch(() => 0)
}

function transferSummary(state: TransferState): Record<string, unknown> {
  return { id: state.id, committed: state.committed, expiresAt: transferExpiresAt(state) }
}

async function handleInfo(ctx: Context): Promise<Response> {
  const { db } = ctx.runtime
  const migrations = await db<{ id: string }>`select id from schema_migrations order by id`
  const files = await walkFiles(ctx.uploadsDir, ctx.managerDir)
  const transfer = await loadTransfer(ctx.managerDir)
  return jsonResponse({
    apiVersion: MANAGER_API_VERSION,
    version: SERVER_VERSION,
    database: { kind: ctx.dbPath ? 'sqlite' : 'postgres', sizeBytes: await databaseSize(ctx) },
    migrations: migrations.rows.map((row) => row.id),
    uploads: {
      sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      fileCount: files.length,
    },
    secretKeyFingerprint: await getMasterKeyFingerprint().catch(() => null),
    needsSetup: (await getSetupStatus(db)).needsSetup,
    pendingRestore: hasPendingRestore(ctx.managerDir),
    restoreError: await readRestoreError(ctx.managerDir),
    transfer: transfer ? transferSummary(transfer) : null,
  })
}

async function hasSpaceFor(dir: string, bytes: number): Promise<boolean> {
  await mkdir(dir, { recursive: true })
  const free = await freeBytes(dir)
  return free === null || free > bytes
}

function noSpace(): Response {
  return managerError(507, 'no-space', 'Not enough free disk space for this operation.')
}

function schemaNewer(sourceVersion: string | null, unknownMigrations: string[]): Response {
  const source = sourceVersion ? ` (instatic ${sourceVersion})` : ''
  return managerError(
    409,
    'schema-newer',
    `That database${source} is newer than this server (${SERVER_VERSION}). Upgrade this server first.`,
    { unknownMigrations },
  )
}

async function handleCreateSnapshot(ctx: Context): Promise<Response> {
  const dbPath = ctx.dbPath
  return (
    exclusive(async () => {
      if (!(await hasSpaceFor(ctx.managerDir, await databaseSize(ctx)))) return noSpace()
      // A snapshot is a SQLite file on either engine: SQLite copies its own
      // file, Postgres writes its data out as one.
      const writeCopy = dbPath
        ? (dest: string) => vacuumInto(dbPath, dest)
        : async (dest: string) => {
            await exportPostgresToSqlite(ctx.databaseUrl, dest)
          }
      const snapshot = await createSnapshot(ctx.managerDir, writeCopy, hashes)
      await hashes.save(hashCachePath(ctx.managerDir))
      return jsonResponse(snapshot, { status: 201 })
    }) ?? busy()
  )
}

async function handleRestoreSnapshot(ctx: Context, id: string): Promise<Response> {
  const body = await readJsonBody(ctx.req, RestoreSnapshotSchema, MAX_OPTIONS_BYTES)
  if (body === null) return badBody()
  const restart = body?.restart ?? true
  const revokeSessions = body?.revokeSessions ?? true
  return (
    exclusive(async () => {
      const snapshot = await getSnapshot(ctx.managerDir, id, hashes)
      if (!snapshot) return unknownSnapshot(id)
      if (hasPendingRestore(ctx.managerDir) || (await loadTransfer(ctx.managerDir))) {
        return managerError(409, 'busy', 'A restore or transfer is already in progress.')
      }
      if (!(await hasSpaceFor(ctx.managerDir, snapshot.sizeBytes))) return noSpace()
      const staged = await stageSnapshotRestore(ctx.managerDir, id)
      // Migrations only run forward: a snapshot from a newer release cannot
      // become the database of this (older) server.
      const refusal = inspectForRestore(staged, ctx.manager.knownMigrationIds, snapshot.version)
      if (refusal) {
        await rm(restoreStagingPath(ctx.managerDir), { force: true })
        return refusal
      }
      // A snapshot predates every sign-out and revocation made since it was
      // taken. Restoring it as-is would make those credentials valid again.
      if (revokeSessions) revokeStagedSessions(staged)
      await writePendingRestore(ctx.managerDir, {
        kind: 'snapshot',
        createdAt: new Date().toISOString(),
        databaseApplied: false,
      })
      if (restart) ctx.manager.requestRestart()
      return jsonResponse({ staged: true, restarting: restart }, { status: 202 })
    }) ?? busy()
  )
}

/** Null when `file` is a sound database this server can run; otherwise the refusal. */
function inspectForRestore(file: string, knownMigrationIds: string[], sourceVersion: string | null): Response | null {
  let report
  try {
    report = inspectStagedDatabase(file)
  } catch {
    return managerError(422, 'bad-database', 'That file is not a readable SQLite database.')
  }
  if (!report.integrityOk || report.migrationIds.length === 0) {
    return managerError(422, 'bad-database', 'That database failed its integrity check.')
  }
  const known = new Set(knownMigrationIds)
  const unknownMigrations = report.migrationIds.filter((migrationId) => !known.has(migrationId))
  return unknownMigrations.length > 0 ? schemaNewer(sourceVersion, unknownMigrations) : null
}

async function handleListFiles(ctx: Context): Promise<Response> {
  const withHash = ctx.url.searchParams.get('hash') !== '0'
  const walked = await walkFiles(ctx.uploadsDir, ctx.managerDir)
  const files = []
  for (const file of walked) {
    files.push({
      path: file.path,
      sizeBytes: file.sizeBytes,
      sha256: withHash
        ? await hashes.hash(resolveRelative(ctx.uploadsDir, file.path), file.sizeBytes, file.mtimeMs)
        : null,
    })
  }
  // Entries for files that are gone are dropped, except while a restore is
  // staged: its files are recorded under the paths they are about to get,
  // and are not on disk there yet.
  if (!hasPendingRestore(ctx.managerDir)) {
    hashes.retain(ctx.uploadsDir, new Set(walked.map((file) => resolveRelative(ctx.uploadsDir, file.path))))
  }
  await hashes.save(hashCachePath(ctx.managerDir))
  return jsonResponse({ files })
}

async function handleDownloadFile(ctx: Context, path: string): Promise<Response> {
  const unknown = managerError(404, 'unknown-file', 'No such file.')
  if (!isSafeRelativePath(path)) return unknown
  if (await passesThroughSymlink(ctx.uploadsDir, path)) return unknown
  return (await fileRangeResponse(ctx.req, resolveRelative(ctx.uploadsDir, path))) ?? unknown
}

/** Why a transfer manifest's file list cannot be applied, or null when it can. */
async function manifestProblem(ctx: Context, body: OpenTransferBody): Promise<string | null> {
  const paths = new Set<string>()
  for (const file of body.files) {
    if (!isSafeRelativePath(file.path)) return `Unsafe file path: ${file.path}`
    if (paths.has(file.path)) return `Duplicate file path: ${file.path}`
    paths.add(file.path)
  }
  for (const path of paths) {
    // A path that is also the directory of another cannot exist as both.
    const segments = path.split('/')
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = segments.slice(0, depth).join('/')
      if (paths.has(ancestor)) return `"${ancestor}" is listed both as a file and as a directory.`
    }
    if (await passesThroughSymlink(ctx.uploadsDir, path)) return `The path ${path} passes through a symlink on this server.`
  }
  return null
}

async function handleOpenTransfer(ctx: Context): Promise<Response> {
  const body = await readJsonBody(ctx.req, OpenTransferSchema, MAX_MANIFEST_BYTES)
  if (!body) return managerError(400, 'bad-request', 'Invalid transfer manifest.')
  const problem = await manifestProblem(ctx, body)
  if (problem) return managerError(400, 'bad-request', problem)

  return (
    exclusive(async () => {
      const existing = await loadTransfer(ctx.managerDir)
      if (hasPendingRestore(ctx.managerDir) || existing?.committed) {
        return managerError(409, 'busy', 'A restore is staged and waiting for a restart.')
      }
      const known = new Set(ctx.manager.knownMigrationIds)
      const unknownMigrations = body.source.migrations.filter((id) => !known.has(id))
      if (unknownMigrations.length > 0) return schemaNewer(body.source.version, unknownMigrations)
      const fingerprint = await getMasterKeyFingerprint().catch(() => null)
      const sourceFingerprint = body.source.secretKeyFingerprint ?? null
      if (!body.allowSecretKeyMismatch && sourceFingerprint && fingerprint && sourceFingerprint !== fingerprint) {
        return managerError(
          409,
          'secret-key-mismatch',
          'INSTATIC_SECRET_KEY differs from the source, so encrypted settings (AI provider keys, MFA seeds) would be unreadable.',
        )
      }
      // An unfinished earlier transfer is replaced by the new manifest.
      const state = await openTransfer(ctx.managerDir, ctx.uploadsDir, body, hashes)
      await hashes.save(hashCachePath(ctx.managerDir))
      const sizes = new Map(body.files.map((file) => [file.path, file.sizeBytes]))
      const needed = state.missing.reduce((sum, path) => sum + (sizes.get(path) ?? 0), body.database.sizeBytes)
      if (!(await hasSpaceFor(ctx.managerDir, needed))) {
        await abortTransfer(ctx.managerDir)
        return noSpace()
      }
      return jsonResponse(
        { ...transferSummary(state), chunkBytes: TRANSFER_CHUNK_BYTES, missing: state.missing },
        { status: 201 },
      )
    }) ?? busy()
  )
}

/** Read a chunk body, refusing anything past the chunk limit without buffering it. */
async function readChunk(req: Request): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length') ?? '0') > TRANSFER_CHUNK_BYTES) return null
  if (!req.body) return new Uint8Array(0)
  const parts: Uint8Array[] = []
  let total = 0
  const reader = req.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > TRANSFER_CHUNK_BYTES) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

/** Append a chunk to the transfer's database (`path` null) or to one of its files. */
async function handleChunk(ctx: Context, id: string, path: string | null): Promise<Response> {
  const offset = Number(ctx.url.searchParams.get('offset') ?? 'NaN')
  if (!Number.isSafeInteger(offset) || offset < 0) return managerError(400, 'bad-request', 'Missing or invalid offset.')
  const bytes = await readChunk(ctx.req)
  if (!bytes) return managerError(413, 'chunk-too-large', `A chunk may carry at most ${TRANSFER_CHUNK_BYTES} bytes.`)

  return serialized(async () => {
    const state = await currentTransfer(ctx, id)
    if (!state) return unknownTransfer()
    if (state.committed || hasPendingRestore(ctx.managerDir)) {
      return managerError(409, 'committed', 'The transfer is already committed.')
    }
    let target: string
    let declaredSize: number
    if (path === null) {
      target = stagedDatabasePath(ctx.managerDir)
      declaredSize = state.database.sizeBytes
    } else {
      const size = isSafeRelativePath(path) ? missingFileSize(state, path) : null
      if (size === null) {
        return managerError(404, 'not-in-transfer', 'This file is not part of the transfer, or the server already holds it.')
      }
      target = resolveRelative(stagedFilesDir(ctx.managerDir), path)
      declaredSize = size
    }
    const result = await appendChunk(ctx.managerDir, state, target, declaredSize, offset, bytes)
    if (result.ok) return jsonResponse({ receivedBytes: result.receivedBytes })
    if (result.reason === 'offset-mismatch') {
      return managerError(409, 'offset-mismatch', 'The offset does not match the bytes already received.', {
        receivedBytes: result.receivedBytes,
      })
    }
    return managerError(413, 'chunk-too-large', 'The chunk runs past the declared size of this item.', {
      receivedBytes: result.receivedBytes,
    })
  })
}

async function handleCommit(ctx: Context, id: string): Promise<Response> {
  const body = await readJsonBody(ctx.req, CommitTransferSchema, MAX_OPTIONS_BYTES)
  if (body === null) return badBody()
  const restart = body?.restart ?? true
  const revokeSessions = body?.revokeSessions ?? true
  return (
    exclusive(async () => {
      const state = await currentTransfer(ctx, id)
      if (!state) return unknownTransfer()
      if (state.committed || hasPendingRestore(ctx.managerDir)) {
        return managerError(409, 'committed', 'The transfer is already committed.')
      }
      const verification = await verifyTransfer(ctx.managerDir, state)
      if (verification.incomplete.length > 0) {
        return managerError(422, 'incomplete', 'Some items are not fully uploaded.', { items: verification.incomplete })
      }
      if (verification.mismatched.length > 0) {
        return managerError(422, 'checksum-mismatch', 'Some items do not match their checksum.', {
          items: verification.mismatched,
        })
      }

      const staged = stagedDatabasePath(ctx.managerDir)
      const refusal = inspectForRestore(staged, ctx.manager.knownMigrationIds, null)
      if (refusal) return refusal
      if (revokeSessions) revokeStagedSessions(staged)

      // The uploaded files were just read in full to verify them. Remember
      // their hashes under the paths they are about to be moved to, so the
      // next push does not start by re-reading every one of them.
      const declared = new Map(state.files.map((file) => [file.path, file.sha256]))
      for (const path of state.missing) {
        const sha256 = declared.get(path)
        const info = await stat(resolveRelative(stagedFilesDir(ctx.managerDir), path)).catch(() => null)
        if (sha256 && info) hashes.seed(resolveRelative(ctx.uploadsDir, path), info.size, info.mtimeMs, sha256)
      }
      await hashes.save(hashCachePath(ctx.managerDir))

      await writePendingRestore(ctx.managerDir, {
        kind: 'transfer',
        createdAt: new Date().toISOString(),
        databaseApplied: false,
        keep: state.files.map((file) => file.path),
      })
      await markCommitted(ctx.managerDir, state)
      if (restart) ctx.manager.requestRestart()
      return jsonResponse({ staged: true, restarting: restart }, { status: 202 })
    }) ?? busy()
  )
}
