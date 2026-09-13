/**
 * The relay and deleted branches — a forgotten branch refuses its docs even
 * while its registry row still exists, a re-created id is welcome again, and
 * resets queued for a deleted branch never poison the queue.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createCollabRelay, type CollabRelay } from '../../../server/collab/relay'
import { BranchGoneError } from '../../../server/collab/relayBranches'
import { deleteBranch } from '../../../server/branches/deleteBranch'
import { forkBranch } from '../../../server/branches/fork'
import { branchExists } from '../../../server/repositories/branches'
import { getCollabDocumentState } from '../../../server/repositories/collabDocuments'
import type { DbClient } from '../../../server/db/client'
import { notifyRowWrite } from '../../../server/repositories/rowWriteEvents'
import { listDataRows, upsertDataRowDraft } from '../../../server/repositories/data'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { LOCAL_ORIGIN } from '@core/collab'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

describe('collab relay and branches', () => {
  let harness: CapabilityTestHarness | null = null
  let relay: CollabRelay | null = null

  afterEach(async () => {
    // A deadlock regression surfaces here as the hook timing out.
    await relay?.destroy()
    relay = null
    await harness?.cleanup()
    harness = null
  })

  it('opens a forked branch, refuses it once forgotten, and accepts it again when re-created', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    await forkBranch(harness.db, { id: 'feature', name: 'Feature', fromBranchId: 'main', createdByUserId: null })
    relay = createCollabRelay(harness.db, { persistDebounceMs: 5 })

    await expect(relay.openDoc('site:feature')).resolves.toBeTruthy()
    await expect(relay.openDoc('site:nope')).rejects.toBeInstanceOf(BranchGoneError)

    // Forgotten BEFORE the registry row goes — the tombstone alone refuses.
    await relay.forgetBranch('feature')
    await expect(relay.openDoc('site:feature')).rejects.toBeInstanceOf(BranchGoneError)
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    await expect(relay.openDoc(`page:feature:${home!.id}`)).rejects.toBeInstanceOf(BranchGoneError)

    await relay.rememberBranch('feature')
    await expect(relay.openDoc('site:feature')).resolves.toBeTruthy()
    // … and its out-of-relay writes reset its docs again, so an editor never
    // persists a stale doc over rows written around the relay.
    const featureHome = `page:feature:${home!.id}`
    await relay.openDoc(featureHome)
    const resets: string[] = []
    relay.onReset((docId) => resets.push(docId))
    notifyRowWrite({ branchId: 'feature', tableId: 'pages', rowIds: [home!.id], kind: 'update' })
    await relay.flushAll()
    expect(resets).toContain(featureHome)
  })

  it('drops queued resets for a forgotten branch instead of failing every later flush', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    await forkBranch(harness.db, { id: 'doomed', name: 'Doomed', fromBranchId: 'main', createdByUserId: null })
    relay = createCollabRelay(harness.db, { persistDebounceMs: 5 })
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    await relay.openDoc(`page:doomed:${home!.id}`)

    // An out-of-relay write queues a reset for the branch's docs …
    notifyRowWrite({ branchId: 'doomed', tableId: 'pages', rowIds: [home!.id], kind: 'update' })
    // … and the branch is deleted before that reset runs.
    await relay.forgetBranch('doomed')
    await expect(relay.flushAll()).resolves.toBeUndefined()
    await expect(relay.flushAll()).resolves.toBeUndefined()
    await expect(relay.openDoc(`page:doomed:${home!.id}`)).rejects.toBeInstanceOf(BranchGoneError)
    // Main is unaffected.
    await expect(relay.openDoc(`page:main:${home!.id}`)).resolves.toBeTruthy()
  })

  it('accepts a branch again when its delete fails after the tombstone', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    await forkBranch(harness.db, { id: 'sticky', name: 'Sticky', fromBranchId: 'main', createdByUserId: null })
    relay = createCollabRelay(harness.db, { persistDebounceMs: 5 })
    await relay.openDoc('site:sticky')

    // The rows survive a failed delete transaction, so the relay must admit
    // the branch again instead of refusing it until the id is re-forked.
    const failing = new Proxy(harness.db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') return () => Promise.reject(new Error('disk full'))
        const value: unknown = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) satisfies DbClient
    await expect(deleteBranch(failing, 'sticky', relay)).rejects.toThrow('disk full')
    expect(await branchExists(harness.db, 'sticky')).toBe(true)
    await expect(relay.openDoc('site:sticky')).resolves.toBeDefined()
    // Out-of-relay writes on the surviving branch reset its docs again.
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const stickyHome = `page:sticky:${home!.id}`
    await relay.openDoc(stickyHome)
    const resets: string[] = []
    relay.onReset((docId) => resets.push(docId))
    notifyRowWrite({ branchId: 'sticky', tableId: 'pages', rowIds: [home!.id], kind: 'update' })
    await relay.flushAll()
    expect(resets).toContain(stickyHome)
  })

  // A reset dropped for a tombstoned branch — whether it was queued before the
  // tombstone or arrived after it — must not leave an invalidation marker
  // behind: once the branch is admitted again, every persist would report
  // "superseded" and the editor's edits would never reach the row JSON.
  for (const timing of ['before', 'after'] as const) {
    it(`persists edits after a branch comes back when a reset was dropped ${timing} the tombstone`, async () => {
      harness = await createCapabilityTestHarness()
      await harness.setupOwner()
      const branchId = `back-${timing}`
      await forkBranch(harness.db, { id: branchId, name: branchId, fromBranchId: 'main', createdByUserId: null })
      relay = createCollabRelay(harness.db, { persistDebounceMs: 5 })
      const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
      const docId = `page:${branchId}:${home!.id}`
      await relay.openDoc(docId)

      if (timing === 'before') notifyRowWrite({ branchId, tableId: 'pages', rowIds: [home!.id], kind: 'update' })
      await relay.forgetBranch(branchId)
      if (timing === 'after') notifyRowWrite({ branchId, tableId: 'pages', rowIds: [home!.id], kind: 'update' })
      await relay.flushAll()

      await relay.rememberBranch(branchId)
      const { doc } = await relay.retain(docId)
      doc.transact(() => {
        doc.getMap('meta').set('title', `Edited on ${branchId}`)
      }, LOCAL_ORIGIN)
      await relay.flushAll()
      relay.release(docId)

      const { rows } = await harness.db<{ cells_json: unknown }>`
        select cells_json from data_rows where id = ${`${branchId}:${home!.id}`}
      `
      expect(JSON.stringify(rows[0]?.cells_json ?? null)).toContain(`Edited on ${branchId}`)
    })
  }

  it('reseeds a branch from its rows when it comes back, so a dropped reset is not lost', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    await forkBranch(harness.db, { id: 'revived', name: 'Revived', fromBranchId: 'main', createdByUserId: null })
    relay = createCollabRelay(harness.db, { persistDebounceMs: 5 })
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const docId = `page:revived:${home!.id}`
    await relay.openDoc(docId)
    await relay.flushAll()

    // An out-of-relay write lands on the branch and announces itself, but
    // the delete tombstones the branch in the same tick: its reset is dropped
    // with the blob (older than the row) still stored. Then the delete fails.
    await upsertDataRowDraft(harness.db, { branchId: 'revived' }, {
      id: home!.id,
      tableId: 'pages',
      cells: { ...home!.cells, title: 'Written around the relay' },
      slug: home!.slug,
    }, null, { collabInternal: true })
    notifyRowWrite({ branchId: 'revived', tableId: 'pages', rowIds: [home!.id], kind: 'update' })
    await relay.forgetBranch('revived')
    expect(await getCollabDocumentState(harness.db, docId)).not.toBeNull()
    const failing = new Proxy(harness.db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') return () => Promise.reject(new Error('disk full'))
        const value: unknown = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) satisfies DbClient
    await expect(deleteBranch(failing, 'revived', relay)).rejects.toThrow('disk full')

    // The reopened doc carries the row's title, not the stale blob's …
    const { doc } = await relay.retain(docId)
    expect(doc.getMap('meta').get('title')).toBe('Written around the relay')
    // … and the next persist keeps building on it.
    doc.transact(() => {
      doc.getMap('meta').set('title', 'Edited after the revival')
    }, LOCAL_ORIGIN)
    await relay.flushAll()
    relay.release(docId)
    const { rows } = await harness.db<{ cells_json: unknown }>`
      select cells_json from data_rows where id = ${`revived:${home!.id}`}
    `
    expect(JSON.stringify(rows[0]?.cells_json ?? null)).toContain('Edited after the revival')
  })


  it('does not deadlock a reset of a page and its site doc with an open of that page in flight', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    await forkBranch(harness.db, { id: 'race', name: 'Race', fromBranchId: 'main', createdByUserId: null })
    relay = createCollabRelay(harness.db, { persistDebounceMs: 5 })
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const docId = `page:race:${home!.id}`

    // No roster snapshot yet, so this open will reach for the site doc — and
    // the write's reset covers both the page and that site doc. The reset
    // drains the open; the open must not wait on the reset's site gate.
    const opening = relay.openDoc(docId)
    notifyRowWrite({ branchId: 'race', tableId: 'pages', rowIds: [home!.id], kind: 'update' })
    await expect(opening).resolves.toBeTruthy()
    await relay.flushAll()
    await expect(relay.openDoc(docId)).resolves.toBeTruthy()
  })

  it('keeps a branch refused while its revival fails, and admits it once the retry succeeds', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    await forkBranch(harness.db, { id: 'flaky', name: 'Flaky', fromBranchId: 'main', createdByUserId: null })
    // The relay's own db fails every collab_documents statement while `outage` is set.
    let outage = false
    const db = new Proxy(harness.db, {
      apply(target, thisArg, args: unknown[]) {
        const strings = args[0]
        if (outage && Array.isArray(strings) && strings.join('?').includes('collab_documents')) {
          return Promise.reject(new Error('database is down'))
        }
        return Reflect.apply(target, thisArg, args)
      },
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver)
        if (prop === 'unsafe' && typeof value === 'function') {
          return (sql: string, ...rest: unknown[]) => outage && sql.includes('collab_documents')
            ? Promise.reject(new Error('database is down'))
            : (value as (...a: unknown[]) => unknown).call(target, sql, ...rest)
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) satisfies DbClient
    relay = createCollabRelay(db, { persistDebounceMs: 5 })
    await relay.openDoc('site:flaky')
    await relay.forgetBranch('flaky')

    const errorLog = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      outage = true
      await relay.rememberBranch('flaky')
      // Still refused: the purge could not run, so the stale blob may be there.
      await expect(relay.openDoc('site:flaky')).rejects.toBeInstanceOf(BranchGoneError)
      outage = false
      // The next admission retries the purge and lifts the tombstone.
      await expect(relay.openDoc('site:flaky')).resolves.toBeTruthy()
    } finally {
      errorLog.mockRestore()
    }
  })

  it('keeps the ref counts of sockets still bound to a forgotten branch when it comes back', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    await forkBranch(harness.db, { id: 'held', name: 'Held', fromBranchId: 'main', createdByUserId: null })
    relay = createCollabRelay(harness.db, { persistDebounceMs: 5 })
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const docId = `page:held:${home!.id}`

    // Socket A holds the doc when the branch is forgotten (delete attempt) …
    await relay.retain(docId)
    await relay.forgetBranch('held')
    await relay.rememberBranch('held')
    // … socket B binds after the revival, then A's stale close arrives.
    const bound = await relay.retain(docId)
    relay.release(docId)
    // B's doc must survive A's release: the same live instance comes back.
    const again = await relay.retain(docId)
    expect(again.doc).toBe(bound.doc)
    relay.release(docId)
    relay.release(docId)
  })
})
