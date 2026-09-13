/**
 * Architecture gates for the media-storage migration tool.
 *
 * The migration loop must preserve the same correctness invariants as
 * the upload path:
 *   1. Bytes are streamed via `dispatchUpload` (which does the two-phase
 *      sign + host-side stream) — NOT directly via fetch in the handler.
 *      Skipping the dispatcher would bypass the per-asset `beginWrite /
 *      finalizeWrite / abortWrite` commit dance and produce orphaned
 *      destination bytes on failure.
 *   2. Source bytes never cross the QuickJS sandbox boundary. The
 *      reader uses local fs OR Bun's native `fetch` against the
 *      adapter-issued URL — never `__hostCall`, never the QuickJS
 *      bridge.
 *   3. Per-asset DB update lands BEFORE the source delete. Crashing
 *      between "destination written" and "DB updated" must leave the
 *      row pointing at the source (recoverable); crashing between "DB
 *      updated" and "source deleted" must leave the row pointing at
 *      the destination (the bytes are there).
 *   4. Per-role in-memory lock prevents concurrent runs of the same
 *      role. Two concurrent migrations would race on the row update
 *      and produce inconsistent storage_adapter_id / storage_path
 *      pairings.
 *   5. The migration tool only declares 'original' / 'variant' as
 *      supported in v1. Adding font / plugin-pack later requires
 *      thinking through their per-role storage which lives outside
 *      `media_assets` — surface that as a deliberate scope-widening
 *      decision, not a silent extension.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('media migration invariants', () => {
  it('migration loop dispatches uploads through the shared two-phase pipeline', async () => {
    const source = await read('server/handlers/cms/mediaStorageMigration.ts')
    // The executor must use `dispatchUpload` — not raw fetch or a
    // hand-rolled call to the registry. That keeps the abortWrite path
    // wired and orphan-cleanup honest.
    expect(source).toContain("dispatchUpload(args.db, {")
    expect(source).toMatch(/from\s+['"]\.\/mediaUploadDispatch['"]/)
  })

  it('per-asset commit order is destination → DB update → source delete', async () => {
    const source = await read('server/handlers/cms/mediaStorageMigration.ts')
    // We check the textual order of three landmark calls inside the
    // per-asset migration. A regression that swaps these would either
    // delete source bytes before the DB knows about the new ones
    // (data loss) or update the DB before the upload commits (broken
    // public URL until next migration run).
    const dispatchIdx = source.indexOf('dispatchUpload(args.db, {')
    const updateIdx = source.indexOf('updateAssetStorageLocation(args.db, item.id,')
    const deleteIdx = source.indexOf('dispatchDelete(item.storageAdapterId, item.storagePath)')
    expect(dispatchIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeGreaterThan(dispatchIdx)
    expect(deleteIdx).toBeGreaterThan(updateIdx)
  })

  it('source byte reader is sandbox-free (no __hostCall, no quickjs)', async () => {
    const source = await read('server/handlers/cms/mediaStorageReader.ts')
    expect(source).not.toMatch(/__hostCall|callHostApi|quickjsHost/)
    // The reader must use either local fs or a native-fetch path (never the
    // QuickJS bridge). The external path goes through `guardedFetch`, the
    // SSRF-safe wrapper over Bun's `fetch` (a plugin controls that URL, so it
    // must not reach internal addresses — GHSA-rmm7).
    expect(source).toContain('readFile(join(input.uploadsDir')
    expect(source).toMatch(/await\s+guardedFetch\(fetchUrl/)
  })

  it('per-role in-memory lock prevents concurrent migrations of the same role', async () => {
    const source = await read('server/handlers/cms/mediaStorageMigration.ts')
    expect(source).toContain('activeMigrations')
    expect(source).toContain('tryAcquireLock')
    expect(source).toContain('releaseLock')
    // The 409 "already in progress" response is the user-facing
    // surface of the lock. Without it the second migration would
    // silently overlap and corrupt counters.
    expect(source).toMatch(/A migration of role "\$\{role\}" is already in progress/)
  })

  it('v1 migration tool only supports original + variant roles', async () => {
    const source = await read('server/handlers/cms/mediaStorageMigration.ts')
    // The TypeBox schema for the migrate body restricts `role` to exactly
    // 'original' | 'variant' via a Union of Literals. Re-introducing
    // 'avatar' / 'font' / 'plugin-pack' silently would hit code paths
    // that don't exist yet — make the rejection visible as a schema change.
    expect(source).toContain("Type.Literal('original')")
    expect(source).toContain("Type.Literal('variant')")
    // Ensure font/avatar roles are NOT declared as accepted
    expect(source).not.toContain("Type.Literal('font')")
    expect(source).not.toContain("Type.Literal('avatar')")
  })

  it('the storage state endpoint exposes a per-role migration backlog', async () => {
    // The UI surfaces "Migrate N pending →" based on this number.
    // Drift between server + client would either hide a real backlog
    // or show a phantom one.
    const handler = await read('server/handlers/cms/mediaStorageAdmin.ts')
    expect(handler).toContain('countMigrationBacklog')
    expect(handler).toContain('migrationBacklog')

    const client = await read('src/core/persistence/cmsMediaStorage.ts')
    expect(client).toContain('migrationBacklog: {')
  })
})
