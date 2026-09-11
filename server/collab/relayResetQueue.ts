/**
 * Out-of-relay write sources → document resets.
 *
 * Repository writes that bypass the relay (HTTP site saves, data-workspace
 * edits, imports, plugin packs, merges) announce themselves through the
 * row/shell write seams. This module turns those announcements into batched
 * `resetDocs` calls: every write is marked invalidated SYNCHRONOUSLY (so no
 * older persist can slip in before the reset), then the batch runs on a
 * microtask, chained so resets never overlap. A failed batch is retained and
 * retried by the next queue or by an explicit drain.
 */
import { encodeCollabDocId, parseCollabDocId, siteDocId, type CollabDocKind } from '@core/collab'
import {
  registerRowWriteListener,
  registerShellWriteListener,
} from '../repositories/rowWriteEvents'

const TABLE_KIND: Record<string, Exclude<CollabDocKind, 'site'>> = {
  pages: 'page',
  components: 'component',
  layouts: 'layout',
}

interface ResetQueueHooks {
  /** Mark docs invalidated and hand back their versions (see relay.ts). */
  activateInvalidations(docIds: readonly string[]): Map<string, number>
  invalidationVersion(docId: string): number
  resetDocs(docIds: readonly string[], invalidations: ReadonlyMap<string, number>): Promise<void>
  hasRosterSnapshot(branchId: string): boolean
  rosterContains(docId: string): boolean
}

export interface RelayResetQueue {
  queueResetDocs(docIds: readonly string[]): void
  /** Wait for every queued reset; retries a failed batch once when throwing. */
  drainResetQueue(throwOnFailure?: boolean): Promise<void>
  /**
   * A branch was deleted: drop its pending and failed ids so the queue can
   * never retry a reset that has nothing to reseed from. Later resets for
   * the id are filtered by the relay at reset time (its admission decides,
   * so an id forked again — or whose delete failed — is reset normally).
   */
  forgetBranch(branchId: string): void
  /** Detach the row/shell write listeners. */
  detach(): void
}

function branchOf(docId: string): string | null {
  return parseCollabDocId(docId)?.branchId ?? null
}

export function createRelayResetQueue(hooks: ResetQueueHooks): RelayResetQueue {
  const pendingResetDocIds = new Set<string>()
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
      pendingResetDocIds.clear()
      if (batch.length === 0) return
      const invalidations = new Map(
        batch.map((docId) => [docId, hooks.invalidationVersion(docId)]),
      )
      const reset = resetChain.then(() => hooks.resetDocs(batch, invalidations))
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
    const branchId = event.branchId
    const docIds = event.rowIds.map((rowId) => encodeCollabDocId({ kind, branchId, rowId }))
    // The site-document batch API reports creations in its changed-id group as
    // `update`. An id absent from the observed roster therefore also means
    // membership may have changed and site authority must reseed.
    if (
      event.kind !== 'update' ||
      !hooks.hasRosterSnapshot(branchId) ||
      docIds.some((docId) => !hooks.rosterContains(docId))
    ) docIds.push(siteDocId(branchId))
    queueResetDocs(docIds)
  })
  const detachShellListener = registerShellWriteListener((branchId) => {
    queueResetDocs([siteDocId(branchId)])
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

  function forgetBranch(branchId: string): void {
    for (const docId of [...pendingResetDocIds]) {
      if (branchOf(docId) === branchId) pendingResetDocIds.delete(docId)
    }
    for (const docId of [...failedResetDocIds]) {
      if (branchOf(docId) === branchId) failedResetDocIds.delete(docId)
    }
    if (failedResetDocIds.size === 0) failedResetError = null
  }

  return {
    queueResetDocs,
    drainResetQueue,
    forgetBranch,
    detach: () => {
      detachRowListener()
      detachShellListener()
    },
  }
}
