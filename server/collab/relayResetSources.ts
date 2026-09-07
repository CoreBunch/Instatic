/** External row/shell writes invalidate matching CRDT lineages, batched with retryable reset ordering. */
import { encodeCollabDocId, sharedCollabDocId, SITE_DOC_ID, type CollabDocKind } from '@core/collab'
import type { DbClient } from '../db/client'
import { listCollabDocumentIds } from '../repositories/collabDocuments'
import { registerRowWriteListener, registerShellWriteListener } from '../repositories/rowWriteEvents'

const TABLE_KIND: Record<string, Exclude<CollabDocKind, 'site'>> = {
  pages: 'page', components: 'component', layouts: 'layout',
}

interface RelayResetSourceHooks {
  activeDocIds(): Iterable<string>
  activateInvalidations(docIds: readonly string[]): Map<string, number>
  invalidationVersion(docId: string): number
  resetDocs(docIds: readonly string[], invalidations: ReadonlyMap<string, number>): Promise<void>
  hasRosterSnapshot(): boolean
  rosterContains(docId: string): boolean
}

export function createRelayResetSources(db: DbClient, hooks: RelayResetSourceHooks) {
  const pendingResetDocIds = new Set<string>()
  const pendingAllLocaleRows = new Set<string>()
  const failedResetDocIds = new Set<string>()
  let resetBatchScheduled = false
  let resetChain: Promise<void> = Promise.resolve()
  let failedResetError: unknown = null

  function queueResetDocs(docIds: readonly string[]): void {
    // Mark synchronously with the post-commit notification. The microtask
    // batching below must not create a window for an older persist to write.
    const combined = [...new Set([...failedResetDocIds, ...docIds])]
    failedResetDocIds.clear()
    failedResetError = null
    hooks.activateInvalidations(combined)
    for (const docId of combined) pendingResetDocIds.add(docId)
    if (resetBatchScheduled) return
    resetBatchScheduled = true
    queueMicrotask(() => {
      resetBatchScheduled = false
      const batch = [...pendingResetDocIds]
      const allLocaleRows = new Set(pendingAllLocaleRows)
      pendingResetDocIds.clear()
      pendingAllLocaleRows.clear()
      if (batch.length === 0) return
      const invalidations = new Map(
        batch.map((docId) => [docId, hooks.invalidationVersion(docId)]),
      )
      const reset = resetChain.then(async () => {
        if (allLocaleRows.size > 0) {
          const storedIds = await listCollabDocumentIds(db)
          const additional = storedIds.filter((id) => allLocaleRows.has(sharedCollabDocId(id)) && !batch.includes(id))
          batch.push(...additional)
          for (const [id, version] of hooks.activateInvalidations(additional)) invalidations.set(id, version)
        }
        await hooks.resetDocs(batch, invalidations)
      })
      resetChain = reset.then(
        () => undefined,
        (err) => {
          failedResetError = err
          for (const docId of batch) failedResetDocIds.add(docId)
          console.error('[collab] reset after out-of-relay write failed:', err)
        },
      )
    })
  }

  const detachRowListener = registerRowWriteListener((event) => {
    const kind = TABLE_KIND[event.tableId]
    if (!kind) return
    const sharedIds = event.rowIds.map((rowId) => encodeCollabDocId({ kind, rowId }))
    const docIds: string[] = []
    for (const rowId of event.rowIds) {
      const commonId = encodeCollabDocId({ kind, rowId })
      if (event.localeId !== undefined && event.kind === 'update') {
        docIds.push(encodeCollabDocId({ kind, rowId, localeId: event.localeId }))
        if (event.sharedChanged !== false) docIds.push(commonId)
      } else {
        docIds.push(commonId)
        pendingAllLocaleRows.add(commonId)
        // Synchronously invalidate active/opening writes before the DB ID scan.
        for (const id of hooks.activeDocIds()) {
          if (sharedCollabDocId(id) === commonId) docIds.push(id)
        }
      }
    }
    // Creations/deletions change global membership, independently of locale.
    if (
      event.kind !== 'update' ||
      !hooks.hasRosterSnapshot() ||
      sharedIds.some((docId) => !hooks.rosterContains(docId))
    ) docIds.push(SITE_DOC_ID)
    queueResetDocs(docIds)
  })
  const detachShellListener = registerShellWriteListener(() => {
    queueResetDocs([SITE_DOC_ID])
  })

  async function drainResetQueue(throwOnFailure = true): Promise<void> {
    let retriedFailure = false
    for (;;) {
      // Let a batch queued by the current call stack attach to resetChain.
      await Promise.resolve()
      const observed = resetChain
      await observed
      if (failedResetError) {
        if (!throwOnFailure) return
        if (!retriedFailure) {
          const retry = [...failedResetDocIds]
          retriedFailure = true
          queueResetDocs(retry)
          continue
        }
        throw failedResetError
      }
      if (
        !resetBatchScheduled &&
        pendingResetDocIds.size === 0 &&
        resetChain === observed
      ) return
    }
  }

  return {
    drain: drainResetQueue,
    detach() {
      detachRowListener()
      detachShellListener()
    },
  }
}
