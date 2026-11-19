/**
 * Integration tests — Manager API (`/_instatic/manager/v1/*`).
 *
 * Runs the real handler against real SQLite files in a temp directory, and
 * plays the restart by closing the database, calling `applyPendingRestore`
 * the way boot does, and reopening.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createDbClient, type DbClient } from '../../../server/db'
import { runMigrations } from '../../../server/db/runMigrations'
import { tryServeManager } from '../../../server/manager/handler'
import { readManagerConfig } from '../../../server/manager/config'
import { applyPendingRestore, hasPendingRestore, type ApplyOutcome } from '../../../server/manager/pending'
import { hashCachePath, pendingMarkerPath, preRestorePath, restoreStagingPath, transferStatePath } from '../../../server/manager/paths'
import { FileHashCache, moveFile } from '../../../server/manager/fsUtil'
import { dropTransferCache } from '../../../server/manager/transfers'
import { LOGIN_LINK_TTL_MS, createLoginLink, redeemLoginLink } from '../../../server/manager/loginLinks'
import { createUser } from '../../../server/repositories/users'
import { listAuditEvents } from '../../../server/repositories/audit'
import { SESSION_COOKIE_NAME, hashPassword } from '../../../server/auth/tokens'
import type { ServerRuntime } from '../../../server/serverRuntime'
import { SERVER_VERSION } from '../../../server/version'

const TOKEN = 'manager-token-for-tests-0123456789abcdef'
const BASE = 'http://instance.test/_instatic/manager/v1'

interface Instance {
  root: string
  databaseUrl: string
  uploadsDir: string
  managerDir: string
  db: DbClient
  runtime: ServerRuntime
  restarts: number
  dbFile: string
  /** Close the database, apply any staged restore as boot does, reopen. */
  reboot: () => Promise<ApplyOutcome>
  call: (method: string, path: string, init?: { body?: BodyInit; token?: string | null; headers?: Record<string, string> }) => Promise<Response>
  close: () => Promise<void>
}

async function createInstance(token: string | undefined = TOKEN, managerDirInUploads = false): Promise<Instance> {
  const root = await mkdtemp(join(tmpdir(), 'manager-api-'))
  const dbFile = join(root, 'data', 'cms.db')
  const databaseUrl = `sqlite:${dbFile}`
  const uploadsDir = join(root, 'uploads')
  await mkdir(uploadsDir, { recursive: true })
  const config = readManagerConfig(
    { INSTATIC_MANAGER_TOKEN: token, INSTATIC_MANAGER_DIR: managerDirInUploads ? join(uploadsDir, 'manager') : undefined },
    uploadsDir,
    databaseUrl,
  )

  const instance = { root, databaseUrl, dbFile, uploadsDir, managerDir: config.dir, restarts: 0 } as Instance

  async function open(): Promise<void> {
    const { db, migrations } = createDbClient(databaseUrl)
    await runMigrations(db, migrations)
    instance.db = db
    instance.runtime = {
      db,
      uploadsDir,
      databaseUrl,
      manager: {
        config,
        knownMigrationIds: migrations.map((migration) => migration.id),
        requestRestart: () => {
          instance.restarts += 1
        },
      },
    }
  }
  await open()

  instance.reboot = async () => {
    await instance.db.close()
    dropTransferCache()
    const outcome = await applyPendingRestore({ managerDir: config.dir, databaseUrl, uploadsDir })
    await open()
    return outcome
  }
  instance.call = async (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers }
    const bearer = init.token === undefined ? TOKEN : init.token
    if (bearer) headers.authorization = `Bearer ${bearer}`
    const url = new URL(`${BASE}${path}`)
    const req = new Request(url, { method, headers, body: init.body })
    const res = await tryServeManager(req, instance.runtime, url, url.pathname)
    if (!res) throw new Error('manager route did not claim its namespace')
    return res
  }
  instance.close = async () => {
    await instance.db.close()
    await rm(root, { recursive: true, force: true })
  }
  return instance
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeUpload(instance: Instance, path: string, content: string): Promise<void> {
  const target = join(instance.uploadsDir, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function setMarker(instance: Instance, value: string): Promise<void> {
  await instance.db.unsafe('create table if not exists manager_test_marker (value text)')
  await instance.db.unsafe('delete from manager_test_marker')
  await instance.db`insert into manager_test_marker (value) values (${value})`
}

async function readMarker(instance: Instance): Promise<string | null> {
  try {
    const { rows } = await instance.db<{ value: string }>`select value from manager_test_marker`
    return rows[0]?.value ?? null
  } catch {
    return null
  }
}

/** Build the manifest a manager would send for `source`, from a fresh snapshot of it. */
async function buildPush(source: Instance): Promise<{ manifest: Record<string, unknown>; database: Uint8Array; files: Map<string, Uint8Array> }> {
  const snapshot = (await (await source.call('POST', '/snapshots')).json()) as { id: string; sha256: string; sizeBytes: number }
  const database = new Uint8Array(await (await source.call('GET', `/snapshots/${snapshot.id}`)).arrayBuffer())
  const info = (await (await source.call('GET', '/info')).json()) as { version: string; migrations: string[]; secretKeyFingerprint: string | null }
  const listing = (await (await source.call('GET', '/files')).json()) as { files: { path: string; sizeBytes: number; sha256: string }[] }
  const files = new Map<string, Uint8Array>()
  for (const file of listing.files) {
    files.set(file.path, new Uint8Array(await readFile(join(source.uploadsDir, file.path))))
  }
  return {
    manifest: {
      source: { version: info.version, migrations: info.migrations, secretKeyFingerprint: info.secretKeyFingerprint },
      database: { sizeBytes: snapshot.sizeBytes, sha256: snapshot.sha256 },
      files: listing.files,
    },
    database,
    files,
  }
}

let instances: Instance[] = []
async function instance(token?: string, managerDirInUploads = false): Promise<Instance> {
  const created = await createInstance(token, managerDirInUploads)
  instances.push(created)
  return created
}

beforeEach(() => {
  instances = []
})
afterEach(async () => {
  for (const created of instances) await created.close()
})

describe('Manager API — gating', () => {
  it('answers 404 without a configured token, with a wrong token, and with a short token', async () => {
    const disabled = await instance('')
    expect((await disabled.call('GET', '/info')).status).toBe(404)

    const short = await instance('too-short')
    expect((await short.call('GET', '/info', { token: 'too-short' })).status).toBe(404)

    const enabled = await instance()
    expect((await enabled.call('GET', '/info', { token: null })).status).toBe(404)
    expect((await enabled.call('GET', '/info', { token: `${TOKEN}x` })).status).toBe(404)
    expect((await enabled.call('GET', '/info')).status).toBe(200)
  })

  it('owns its namespace: unknown paths are 404, never a fall-through', async () => {
    const enabled = await instance()
    expect((await enabled.call('GET', '/nope')).status).toBe(404)
    const url = new URL('http://instance.test/_instatic/manager/v2/info')
    const res = await tryServeManager(new Request(url), enabled.runtime, url, url.pathname)
    expect(res?.status).toBe(404)
    const other = new URL('http://instance.test/health')
    expect(await tryServeManager(new Request(other), enabled.runtime, other, other.pathname)).toBeNull()
  })

  it('reports version, database and uploads in /info', async () => {
    const enabled = await instance()
    await writeUpload(enabled, 'fonts/a.woff2', 'abc')
    const info = await (await enabled.call('GET', '/info')).json()
    expect(info.apiVersion).toBe(1)
    expect(info.version).toBe(SERVER_VERSION)
    expect(info.database.kind).toBe('sqlite')
    expect(info.migrations.length).toBeGreaterThan(0)
    expect(info.uploads).toEqual({ sizeBytes: 3, fileCount: 1 })
    expect(info.pendingRestore).toBe(false)
    expect(info.restoreError).toBeNull()
    expect(info.transfer).toBeNull()
  })
})

describe('Manager API — snapshots', () => {
  it('creates, lists, downloads with Range, restores on restart, and deletes', async () => {
    const site = await instance()
    await setMarker(site, 'before')
    const created = await site.call('POST', '/snapshots')
    expect(created.status).toBe(201)
    const snapshot = await created.json()
    expect(snapshot.version).toBe(SERVER_VERSION)

    const full = new Uint8Array(await (await site.call('GET', `/snapshots/${snapshot.id}`)).arrayBuffer())
    expect(full.byteLength).toBe(snapshot.sizeBytes)
    expect(sha256(full)).toBe(snapshot.sha256)
    const ranged = await site.call('GET', `/snapshots/${snapshot.id}`, { headers: { range: 'bytes=10-19' } })
    expect(ranged.status).toBe(206)
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(full.slice(10, 20))

    await setMarker(site, 'after')
    const restore = await site.call('POST', `/snapshots/${snapshot.id}/restore`)
    expect(restore.status).toBe(202)
    expect(site.restarts).toBe(1)
    expect(await readMarker(site)).toBe('after') // nothing live is touched before the restart

    expect(await site.reboot()).toEqual({ status: 'applied', kind: 'snapshot' })
    expect(await readMarker(site)).toBe('before')
    expect(hasPendingRestore(site.managerDir)).toBe(false)
    // The replaced database is kept beside the live one as a one-step undo.
    expect(existsSync(preRestorePath(site.dbFile))).toBe(true)

    const list = await (await site.call('GET', '/snapshots')).json()
    expect(list.map((entry: { id: string }) => entry.id)).toEqual([snapshot.id])
    expect((await site.call('DELETE', `/snapshots/${snapshot.id}`)).status).toBe(200)
    expect((await site.call('DELETE', `/snapshots/${snapshot.id}`)).status).toBe(404)
    expect(await (await site.call('GET', '/snapshots')).json()).toEqual([])
    expect((await site.call('GET', `/snapshots/${snapshot.id}`)).status).toBe(404)
  })

  it('stages a restore without restarting when asked', async () => {
    const site = await instance()
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    const res = await site.call('POST', `/snapshots/${snapshot.id}/restore`, { body: JSON.stringify({ restart: false }) })
    expect(await res.json()).toEqual({ staged: true, restarting: false })
    expect(site.restarts).toBe(0)
    expect(hasPendingRestore(site.managerDir)).toBe(true)
    // A second restore or a transfer must wait for the staged one.
    expect((await site.call('POST', `/snapshots/${snapshot.id}/restore`)).status).toBe(409)
  })

  it('rejects ids that are not snapshot names', async () => {
    const site = await instance()
    expect((await site.call('GET', '/snapshots/..%2F..%2Fdata%2Fcms.db')).status).toBe(404)
    expect((await site.call('DELETE', '/snapshots/pending.json')).status).toBe(404)
  })
})

describe('Manager API — files', () => {
  it('lists uploads with hashes and serves them, hiding the manager directory', async () => {
    const site = await instance()
    await writeUpload(site, 'media/one.txt', 'one')
    await (await site.call('POST', '/snapshots')).json()
    const { files } = await (await site.call('GET', '/files')).json()
    expect(files).toEqual([{ path: 'media/one.txt', sizeBytes: 3, sha256: sha256('one') }])
    expect(await (await site.call('GET', '/files/media/one.txt')).text()).toBe('one')
    expect((await site.call('GET', '/files/media/missing.txt')).status).toBe(404)
    expect((await site.call('GET', '/files/..%2Fdata%2Fcms.db')).status).toBe(404)
  })
})

describe('Manager API — transfers', () => {
  it('pushes a full instance: only missing files upload, the swap happens on restart', async () => {
    const source = await instance()
    const target = await instance()
    await setMarker(source, 'from-source')
    await writeUpload(source, 'media/shared.txt', 'same on both')
    await writeUpload(source, 'media/new.txt', 'only on source')
    await writeUpload(source, 'published/empty', '')
    await writeUpload(target, 'media/shared.txt', 'same on both')
    await writeUpload(target, 'media/stale.txt', 'only on target')

    const push = await buildPush(source)
    const opened = await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })
    expect(opened.status).toBe(201)
    const transfer = await opened.json()
    expect(transfer.missing.sort()).toEqual(['media/new.txt', 'published/empty'])

    // Database in two chunks, with a retried first chunk in between.
    const half = Math.floor(push.database.byteLength / 2)
    const dbUrl = `/transfers/${transfer.id}/database`
    expect((await target.call('PUT', `${dbUrl}?offset=0`, { body: push.database.slice(0, half) })).status).toBe(200)
    const retried = await target.call('PUT', `${dbUrl}?offset=0`, { body: push.database.slice(0, half) })
    expect(retried.status).toBe(409)
    expect((await retried.json()).receivedBytes).toBe(half)

    // Committing early names what is still missing.
    const early = await target.call('POST', `/transfers/${transfer.id}/commit`)
    expect(early.status).toBe(422)
    expect((await early.json()).error).toBe('incomplete')

    // A manager that lost its state reads progress and resumes.
    const progress = await (await target.call('GET', `/transfers/${transfer.id}`)).json()
    expect(progress.database.receivedBytes).toBe(half)
    expect((await target.call('PUT', `${dbUrl}?offset=${half}`, { body: push.database.slice(half) })).status).toBe(200)

    const newFile = push.files.get('media/new.txt')
    if (!newFile) throw new Error('fixture file missing')
    expect((await target.call('PUT', `/transfers/${transfer.id}/files/media/new.txt?offset=0`, { body: newFile })).status).toBe(200)
    // Files the server already holds, or never listed, are refused.
    expect((await target.call('PUT', `/transfers/${transfer.id}/files/media/shared.txt?offset=0`, { body: 'x' })).status).toBe(404)
    expect((await target.call('PUT', `/transfers/${transfer.id}/files/..%2Fescape?offset=0`, { body: 'x' })).status).toBe(404)

    const commit = await target.call('POST', `/transfers/${transfer.id}/commit`)
    expect(commit.status).toBe(202)
    expect(target.restarts).toBe(1)
    expect(existsSync(join(target.uploadsDir, 'media/stale.txt'))).toBe(true) // untouched until restart

    await target.reboot()
    expect(await readMarker(target)).toBe('from-source')
    expect(await readFile(join(target.uploadsDir, 'media/new.txt'), 'utf-8')).toBe('only on source')
    expect(await readFile(join(target.uploadsDir, 'media/shared.txt'), 'utf-8')).toBe('same on both')
    expect(await readFile(join(target.uploadsDir, 'published/empty'), 'utf-8')).toBe('')
    expect(existsSync(join(target.uploadsDir, 'media/stale.txt'))).toBe(false)
    expect(existsSync(join(target.managerDir, 'transfer'))).toBe(false)
    expect((await (await target.call('GET', '/info')).json()).transfer).toBeNull()

    // Applying twice (a crash after the swap, before the marker was removed) is harmless.
    await target.reboot()
    expect(await readMarker(target)).toBe('from-source')
  })

  it('rejects a corrupted upload at commit and keeps the live data', async () => {
    const source = await instance()
    const target = await instance()
    await setMarker(target, 'live')
    const push = await buildPush(source)
    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    const corrupted = push.database.slice()
    corrupted[corrupted.byteLength - 1] = (corrupted[corrupted.byteLength - 1] ?? 0) ^ 0xff
    const put = await target.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: corrupted })
    expect(await put.json()).toEqual({ receivedBytes: corrupted.byteLength })
    const commit = await target.call('POST', `/transfers/${transfer.id}/commit`)
    expect(commit.status).toBe(422)
    expect((await commit.json()).error).toBe('checksum-mismatch')
    expect(hasPendingRestore(target.managerDir)).toBe(false)
    await target.reboot()
    expect(await readMarker(target)).toBe('live')
  })

  it('refuses a source database newer than this server, and a different secret key', async () => {
    const source = await instance()
    const target = await instance()
    const push = await buildPush(source)
    const source_ = push.manifest.source as { migrations: string[]; secretKeyFingerprint: string | null }

    const newer = { ...push.manifest, source: { ...source_, migrations: [...source_.migrations, '999_from_the_future'] } }
    const refused = await target.call('POST', '/transfers', { body: JSON.stringify(newer) })
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toBe('schema-newer')

    const otherKey = { ...push.manifest, source: { ...source_, secretKeyFingerprint: 'someone-elses-key' } }
    const mismatch = await target.call('POST', '/transfers', { body: JSON.stringify(otherKey) })
    expect(mismatch.status).toBe(409)
    expect((await mismatch.json()).error).toBe('secret-key-mismatch')
    const allowed = await target.call('POST', '/transfers', { body: JSON.stringify({ ...otherKey, allowSecretKeyMismatch: true }) })
    expect(allowed.status).toBe(201)
  })

  it('rejects unsafe paths in the manifest and oversized chunks', async () => {
    const source = await instance()
    const target = await instance()
    const push = await buildPush(source)
    const evil = { ...push.manifest, files: [{ path: '../escape.txt', sizeBytes: 1, sha256: sha256('x') }] }
    expect((await target.call('POST', '/transfers', { body: JSON.stringify(evil) })).status).toBe(400)

    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    const tooBig = new Uint8Array(transfer.chunkBytes + 1)
    expect((await target.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: tooBig })).status).toBe(413)
    expect((await target.call('DELETE', `/transfers/${transfer.id}`)).status).toBe(200)
    expect((await target.call('GET', `/transfers/${transfer.id}`)).status).toBe(404)
  })
})

describe('Manager API — review hardening', () => {
  it('never purges uploads for a marker whose staged database is missing', async () => {
    const site = await instance()
    await setMarker(site, 'live')
    await writeUpload(site, 'media/keep-me.txt', 'still here')
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    await site.call('POST', `/snapshots/${snapshot.id}/restore`, { body: JSON.stringify({ restart: false }) })
    // A transfer-shaped marker with nothing staged behind it: the worst case
    // would pair the old database with a purged uploads tree.
    await writeFile(
      pendingMarkerPath(site.managerDir),
      JSON.stringify({ kind: 'transfer', createdAt: new Date().toISOString(), databaseApplied: false, keep: [] }),
    )
    await rm(restoreStagingPath(site.managerDir), { force: true })

    expect(await site.reboot()).toEqual({ status: 'discarded', reason: 'the staged database was missing' })
    expect(await readFile(join(site.uploadsDir, 'media/keep-me.txt'), 'utf-8')).toBe('still here')
    expect(await readMarker(site)).toBe('live')
    expect(hasPendingRestore(site.managerDir)).toBe(false)
  })

  it('finishes a database swap that was interrupted between its two renames', async () => {
    const site = await instance()
    await setMarker(site, 'live')
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    await setMarker(site, 'newer')
    await site.call('POST', `/snapshots/${snapshot.id}/restore`, { body: JSON.stringify({ restart: false }) })
    // The state a kill leaves behind after the live database was set aside
    // and before the new one was renamed into place: the staged file has
    // already moved beside the database, and no live database exists.
    await site.db.close()
    await rename(restoreStagingPath(site.managerDir), `${site.dbFile}.incoming`)
    await rename(site.dbFile, preRestorePath(site.dbFile))
    await rm(`${site.dbFile}-wal`, { force: true })
    await rm(`${site.dbFile}-shm`, { force: true })

    const outcome = await applyPendingRestore({
      managerDir: site.managerDir,
      databaseUrl: site.databaseUrl,
      uploadsDir: site.uploadsDir,
    })
    await site.reboot().catch(() => undefined)

    expect(outcome).toEqual({ status: 'applied', kind: 'snapshot' })
    // The restore completed: the server is not left to boot an empty database.
    expect(await readMarker(site)).toBe('live')
    expect(existsSync(`${site.dbFile}.incoming`)).toBe(false)
  })

  it('finishes a database swap that was interrupted before the live database was set aside', async () => {
    const site = await instance()
    await setMarker(site, 'live')
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    await setMarker(site, 'newer')
    await site.call('POST', `/snapshots/${snapshot.id}/restore`, { body: JSON.stringify({ restart: false }) })
    // Killed right after the staged file moved beside the database.
    await rename(restoreStagingPath(site.managerDir), `${site.dbFile}.incoming`)

    expect(await site.reboot()).toEqual({ status: 'applied', kind: 'snapshot' })
    expect(await readMarker(site)).toBe('live')
  })

  it('carries on after a swap that finished but was never recorded', async () => {
    const site = await instance()
    await setMarker(site, 'live')
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    await setMarker(site, 'newer')
    await site.call('POST', `/snapshots/${snapshot.id}/restore`, { body: JSON.stringify({ restart: false }) })
    // Killed after the new database was renamed into place and before the
    // marker said so: the swap is done, nothing is staged, the marker remains.
    await site.db.close()
    await rename(site.dbFile, preRestorePath(site.dbFile))
    await rename(restoreStagingPath(site.managerDir), site.dbFile)
    await writeFile(
      pendingMarkerPath(site.managerDir),
      JSON.stringify({ kind: 'snapshot', createdAt: new Date().toISOString(), databaseSwapStarted: true, databaseApplied: false }),
    )

    const outcome = await applyPendingRestore({
      managerDir: site.managerDir,
      databaseUrl: site.databaseUrl,
      uploadsDir: site.uploadsDir,
    })
    await site.reboot().catch(() => undefined)

    expect(outcome).toEqual({ status: 'applied', kind: 'snapshot' })
    expect(await readMarker(site)).toBe('live')
    expect(hasPendingRestore(site.managerDir)).toBe(false)
  })

  it('boots on a failed apply, reports it, and retries on the next start', async () => {
    const site = await instance()
    await setMarker(site, 'live')
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    await setMarker(site, 'newer')
    await site.call('POST', `/snapshots/${snapshot.id}/restore`, { body: JSON.stringify({ restart: false }) })
    // Something in the way of the swap: apply cannot finish.
    await mkdir(`${site.dbFile}.incoming`)
    await writeFile(join(`${site.dbFile}.incoming`, 'blocker'), 'x')

    const failed = await site.reboot()
    expect(failed.status).toBe('failed')
    expect(await readMarker(site)).toBe('newer') // the live database is untouched
    const info = await (await site.call('GET', '/info')).json()
    expect(info.pendingRestore).toBe(true)
    expect(typeof info.restoreError).toBe('string')

    await rm(`${site.dbFile}.incoming`, { recursive: true })
    expect(await site.reboot()).toEqual({ status: 'applied', kind: 'snapshot' })
    expect(await readMarker(site)).toBe('live')
    expect((await (await site.call('GET', '/info')).json()).restoreError).toBeNull()
  })

  it('refuses invalid option bodies instead of applying destructive defaults', async () => {
    const site = await instance()
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    const bad = await site.call('POST', `/snapshots/${snapshot.id}/restore`, { body: JSON.stringify({ restart: 'false' }) })
    expect(bad.status).toBe(400)
    expect(site.restarts).toBe(0)
    expect(hasPendingRestore(site.managerDir)).toBe(false)

    const source = await instance()
    const push = await buildPush(source)
    const transfer = await (await site.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    await site.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: push.database })
    const badCommit = await site.call('POST', `/transfers/${transfer.id}/commit`, { body: '{"revokeSessions":"no"}' })
    expect(badCommit.status).toBe(400)
    expect(hasPendingRestore(site.managerDir)).toBe(false)
  })

  it('a committed transfer cannot be aborted behind the marker, only cancelled as a whole', async () => {
    const source = await instance()
    const target = await instance()
    await setMarker(target, 'live')
    await writeUpload(target, 'media/live.txt', 'live file')
    const push = await buildPush(source)
    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    await target.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: push.database })
    const commit = await target.call('POST', `/transfers/${transfer.id}/commit`, { body: JSON.stringify({ restart: false }) })
    expect(commit.status).toBe(202)

    expect((await target.call('DELETE', `/transfers/${transfer.id}`)).status).toBe(409)
    expect((await target.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: 'x' })).status).toBe(409)
    expect((await target.call('DELETE', '/pending-restore')).status).toBe(200)
    expect((await target.call('DELETE', '/pending-restore')).status).toBe(404)

    expect(await target.reboot()).toEqual({ status: 'none' })
    expect(await readMarker(target)).toBe('live')
    expect(await readFile(join(target.uploadsDir, 'media/live.txt'), 'utf-8')).toBe('live file')
  })

  it('serializes concurrent chunk uploads to the same item', async () => {
    const source = await instance()
    const target = await instance()
    const push = await buildPush(source)
    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    const url = `/transfers/${transfer.id}/database?offset=0`
    const responses = await Promise.all([
      target.call('PUT', url, { body: push.database }),
      target.call('PUT', url, { body: push.database }),
      target.call('PUT', url, { body: push.database }),
    ])
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409, 409])
    const progress = await (await target.call('GET', `/transfers/${transfer.id}`)).json()
    expect(progress.database.receivedBytes).toBe(push.database.byteLength)
    expect((await target.call('POST', `/transfers/${transfer.id}/commit`, { body: JSON.stringify({ restart: false }) })).status).toBe(202)
  })

  it('applies a transfer where a file replaces a directory and a directory replaces a file', async () => {
    const source = await instance()
    const target = await instance()
    await writeUpload(source, 'a', 'a is a file on the source')
    await writeUpload(source, 'b/inner.txt', 'b is a directory on the source')
    await writeUpload(target, 'a/old.txt', 'a is a directory on the target')
    await writeUpload(target, 'b', 'b is a file on the target')
    const push = await buildPush(source)
    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    await target.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: push.database })
    for (const path of transfer.missing as string[]) {
      const bytes = push.files.get(path)
      if (!bytes) throw new Error(`fixture file missing: ${path}`)
      await target.call('PUT', `/transfers/${transfer.id}/files/${path}?offset=0`, { body: bytes })
    }
    expect((await target.call('POST', `/transfers/${transfer.id}/commit`)).status).toBe(202)
    expect(await target.reboot()).toEqual({ status: 'applied', kind: 'transfer' })
    expect(await readFile(join(target.uploadsDir, 'a'), 'utf-8')).toBe('a is a file on the source')
    expect(await readFile(join(target.uploadsDir, 'b/inner.txt'), 'utf-8')).toBe('b is a directory on the source')
  })

  it('rejects a manifest that lists a path as both file and directory, or through a symlink', async () => {
    const source = await instance()
    const target = await instance()
    const push = await buildPush(source)
    const file = (path: string) => ({ path, sizeBytes: 1, sha256: sha256('x') })
    const both = { ...push.manifest, files: [file('a'), file('a/b')] }
    expect((await target.call('POST', '/transfers', { body: JSON.stringify(both) })).status).toBe(400)

    const outside = await mkdtemp(join(tmpdir(), 'manager-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'outside the uploads root')
      await symlink(outside, join(target.uploadsDir, 'link'))
      const through = { ...push.manifest, files: [file('link/planted.txt')] }
      expect((await target.call('POST', '/transfers', { body: JSON.stringify(through) })).status).toBe(400)
      expect((await target.call('GET', '/files/link/secret.txt')).status).toBe(404)
      const { files } = await (await target.call('GET', '/files')).json()
      expect(files).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses to restore a snapshot from a newer schema', async () => {
    const site = await instance()
    await site.db`insert into schema_migrations (id, applied_at) values ('999_from_the_future', 'now')`
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    await site.db`delete from schema_migrations where id = '999_from_the_future'`
    const refused = await site.call('POST', `/snapshots/${snapshot.id}/restore`)
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toBe('schema-newer')
    expect(hasPendingRestore(site.managerDir)).toBe(false)
    expect(site.restarts).toBe(0)
  })

  it('survives a corrupt transfer state file', async () => {
    const source = await instance()
    const target = await instance()
    const push = await buildPush(source)
    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    await writeFile(transferStatePath(target.managerDir), '{ not json')
    await target.reboot() // a restart drops the in-memory copy, as in production
    expect((await target.call('GET', '/info')).status).toBe(200)
    expect((await target.call('GET', `/transfers/${transfer.id}`)).status).toBe(404)
    expect((await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).status).toBe(201)
  })

  it('refuses to operate when the manager directory is inside the public uploads tree', async () => {
    const site = await instance(TOKEN, true)
    const res = await site.call('GET', '/info')
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('misconfigured')
    expect((await site.call('POST', '/snapshots')).status).toBe(503)
  })

  it('clears MCP OAuth tokens along with sessions when a transfer revokes sessions', async () => {
    const source = await instance()
    const target = await instance()
    await source.db.unsafe(`
      insert into ai_mcp_connectors (id, user_id, name, token_hash, token_prefix, scopes_json)
        select 'c1', 'u1', 'c', 'h', 'p', '[]' where 0;
    `).catch(() => undefined)
    const push = await buildPush(source)
    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    await target.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: push.database })
    expect((await target.call('POST', `/transfers/${transfer.id}/commit`)).status).toBe(202)
    expect(await target.reboot()).toEqual({ status: 'applied', kind: 'transfer' })
    for (const table of ['sessions', 'ai_mcp_oauth_tokens', 'ai_mcp_oauth_codes']) {
      const { rows } = await target.db.unsafe(`select count(*) as n from ${table}`)
      expect(Number((rows[0] as { n: number }).n)).toBe(0)
    }
  })
})

describe('Manager API — snapshot restore and credentials', () => {
  async function sessionCount(site: Instance): Promise<number> {
    const { rows } = await site.db.unsafe('select count(*) as n from sessions')
    return Number((rows[0] as { n: number }).n)
  }

  async function addSession(site: Instance): Promise<void> {
    await site.db.unsafe('pragma foreign_keys = off')
    await site.db.unsafe(`
      insert into sessions (id_hash, user_id, expires_at)
      values ('hash-${crypto.randomUUID()}', 'user-1', '2999-01-01T00:00:00.000Z')
    `)
    await site.db.unsafe('pragma foreign_keys = on')
  }

  it('does not bring back sessions that existed when the snapshot was taken', async () => {
    const site = await instance()
    await addSession(site)
    expect(await sessionCount(site)).toBe(1)
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    // The session is signed out after the snapshot.
    await site.db.unsafe('delete from sessions')

    expect((await site.call('POST', `/snapshots/${snapshot.id}/restore`)).status).toBe(202)
    expect(await site.reboot()).toEqual({ status: 'applied', kind: 'snapshot' })
    expect(await sessionCount(site)).toBe(0)
  })

  it('keeps sessions only when the caller asks for that explicitly', async () => {
    const site = await instance()
    await addSession(site)
    const snapshot = await (await site.call('POST', '/snapshots')).json()
    const res = await site.call('POST', `/snapshots/${snapshot.id}/restore`, { body: JSON.stringify({ revokeSessions: false }) })
    expect(res.status).toBe(202)
    await site.reboot()
    expect(await sessionCount(site)).toBe(1)
  })
})

describe('Manager API: symlinks at apply time', () => {
  it('does not write through a symlink that appeared after the transfer was validated', async () => {
    const source = await instance()
    const target = await instance()
    await writeUpload(source, 'media/new.txt', 'from the source')
    const push = await buildPush(source)
    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    await target.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: push.database })
    const bytes = push.files.get('media/new.txt')
    if (!bytes) throw new Error('fixture file missing')
    await target.call('PUT', `/transfers/${transfer.id}/files/media/new.txt?offset=0`, { body: bytes })
    expect((await target.call('POST', `/transfers/${transfer.id}/commit`)).status).toBe(202)

    const outside = await mkdtemp(join(tmpdir(), 'manager-outside-'))
    try {
      // Between commit and restart, `media` becomes a link out of the root.
      await symlink(outside, join(target.uploadsDir, 'media'))
      expect(await target.reboot()).toEqual({ status: 'applied', kind: 'transfer' })
      expect(existsSync(join(outside, 'new.txt'))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('Manager API: one-time sign-in links', () => {
  async function addOwner(site: Instance): Promise<string> {
    const owner = await createUser(site.db, {
      email: 'owner@example.com',
      displayName: 'Owner',
      passwordHash: await hashPassword('a-long-enough-password'),
      roleId: 'owner',
      allowOwnerRole: true,
    })
    return owner.id
  }

  it('signs the owner in once, without a password, and redirects to the admin', async () => {
    const site = await instance()
    const ownerId = await addOwner(site)
    const created = await site.call('POST', '/login-links')
    expect(created.status).toBe(201)
    const link = await created.json()
    expect(link.path.startsWith('/_instatic/manager/v1/login/')).toBe(true)
    const linkPath = link.path.slice('/_instatic/manager/v1'.length)

    // The browser opens the link with no bearer token.
    const redeemed = await site.call('GET', linkPath, { token: null })
    expect(redeemed.status).toBe(302)
    expect(redeemed.headers.get('location')).toBe('/admin')
    expect(redeemed.headers.get('cache-control')).toBe('no-store')
    const cookie = redeemed.headers.get('set-cookie') ?? ''
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
    expect(cookie).toContain('HttpOnly')

    const { rows } = await site.db<{ user_id: string; mfa_passed_at: string | null }>`select user_id, mfa_passed_at from sessions`
    expect(rows.length).toBe(1)
    expect(rows[0]?.user_id).toBe(ownerId)
    expect(rows[0]?.mfa_passed_at).not.toBeNull()
    const events = await listAuditEvents(site.db, 5)
    expect(events.some((event) => event.action === 'login.success' && event.metadata.method === 'manager-link')).toBe(true)

    // A link works once.
    expect((await site.call('GET', linkPath, { token: null })).status).toBe(404)
  })

  it('needs the manager token to mint a link and an owner to sign in', async () => {
    const site = await instance()
    expect((await site.call('POST', '/login-links', { token: null })).status).toBe(404)
    const noOwner = await site.call('POST', '/login-links')
    expect(noOwner.status).toBe(409)
    expect((await noOwner.json()).error).toBe('needs-setup')
    expect((await site.call('GET', '/login/not-a-real-token', { token: null })).status).toBe(404)
    expect((await site.call('GET', '/login/', { token: null })).status).toBe(404)
  })

  it('does not exist when the Manager API is disabled', async () => {
    const disabled = await instance('')
    expect((await disabled.call('GET', '/login/anything', { token: null })).status).toBe(404)
  })

  it('expires a link after its short lifetime', () => {
    const now = Date.now()
    const link = createLoginLink('user-1', now)
    expect(redeemLoginLink(link.token, now + LOGIN_LINK_TTL_MS + 1)).toBeNull()
    const fresh = createLoginLink('user-1', now)
    expect(redeemLoginLink(fresh.token, now + 1000)).toBe('user-1')
    expect(redeemLoginLink(fresh.token, now + 1000)).toBeNull()
  })
})

describe('Manager API: hashes of pushed files are remembered', () => {
  it('answers from a seeded entry without reading the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manager-hash-'))
    try {
      const file = join(dir, 'a.txt')
      await writeFile(file, 'the real content')
      const info = await stat(file)
      const cache = new FileHashCache()
      // A deliberately wrong hash: getting it back proves the file was not read.
      cache.seed(file, info.size, info.mtimeMs, 'seeded-not-computed')
      expect(await cache.hash(file, info.size, info.mtimeMs)).toBe('seeded-not-computed')
      // A different size or modification time is a different file: it is read.
      expect(await cache.hash(file, info.size, info.mtimeMs + 1)).toBe(sha256('the real content'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records pushed files under their final paths, valid after the restart', async () => {
    const source = await instance()
    const target = await instance()
    await writeUpload(source, 'media/new.txt', 'pushed content')
    const push = await buildPush(source)
    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    await target.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: push.database })
    const bytes = push.files.get('media/new.txt')
    if (!bytes) throw new Error('fixture file missing')
    await target.call('PUT', `/transfers/${transfer.id}/files/media/new.txt?offset=0`, { body: bytes })
    expect((await target.call('POST', `/transfers/${transfer.id}/commit`)).status).toBe(202)
    expect(await target.reboot()).toEqual({ status: 'applied', kind: 'transfer' })

    // What a restarted server loads: the persisted cache must describe the
    // moved file exactly, or the next push would read it again.
    const finalPath = join(target.uploadsDir, 'media/new.txt')
    const info = await stat(finalPath)
    const persisted = JSON.parse(await readFile(hashCachePath(target.managerDir), 'utf-8')) as Record<
      string,
      { sizeBytes: number; mtimeMs: number; sha256: string }
    >
    expect(persisted[finalPath]).toEqual({ sizeBytes: info.size, mtimeMs: info.mtimeMs, sha256: sha256('pushed content') })
  })

  it('never answers with a pushed file\'s hash for the old file when the push is cancelled', async () => {
    const source = await instance()
    const target = await instance()
    // Same path and same size on both sides, different content.
    await writeUpload(source, 'media/page.txt', 'NEW content!')
    await writeUpload(target, 'media/page.txt', 'old content.')
    const push = await buildPush(source)
    const transfer = await (await target.call('POST', '/transfers', { body: JSON.stringify(push.manifest) })).json()
    await target.call('PUT', `/transfers/${transfer.id}/database?offset=0`, { body: push.database })
    const bytes = push.files.get('media/page.txt')
    if (!bytes) throw new Error('fixture file missing')
    await target.call('PUT', `/transfers/${transfer.id}/files/media/page.txt?offset=0`, { body: bytes })
    const commit = await target.call('POST', `/transfers/${transfer.id}/commit`, { body: JSON.stringify({ restart: false }) })
    expect(commit.status).toBe(202)

    // Cancelled: the old file stays. Its hash must be its own, not the one
    // recorded for the file that was going to replace it.
    expect((await target.call('DELETE', '/pending-restore')).status).toBe(200)
    const { files } = await (await target.call('GET', '/files')).json()
    expect(files).toEqual([{ path: 'media/page.txt', sizeBytes: 12, sha256: sha256('old content.') }])
  })

  // The cross-filesystem copy path cannot be forced here; this covers the
  // contract both paths share, which the hash cache relies on.
  it('keeps the modification time of a moved file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manager-move-'))
    try {
      const from = join(dir, 'a.txt')
      await writeFile(from, 'moved')
      const before = await stat(from)
      await moveFile(from, join(dir, 'sub', 'b.txt'))
      const after = await stat(join(dir, 'sub', 'b.txt'))
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(existsSync(from)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
