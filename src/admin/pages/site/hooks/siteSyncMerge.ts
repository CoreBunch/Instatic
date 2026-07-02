/**
 * siteSyncMerge — the merge POLICY of the live-pull channel: what one
 * incoming sync event does to the editor store. The transport (WebSocket
 * lifecycle, ordering, reconnect) lives in `useSiteSocket`; keeping the
 * policy separate makes it testable with a plain fake snapshot fetcher.
 *
 * Merge rule per event target (order matters):
 *   1. base seq already ≥ event seq → skip. Absorbs the echo of this
 *      editor's own saves when the save response beat the event.
 *   2. target dirty locally → do NOT touch it; add a pending conflict — the
 *      same banner as a 409'd save, one resolution UX for levels A and B.
 *   3. clean → fetch the current remote state and `applyRemoteSnapshot` it.
 *      Dirtiness is re-checked after the fetch (an edit can land mid-wire).
 *      The apply deep-equal-skips identical content (own-save echoes that
 *      outran the response), so undo history only resets when remote content
 *      genuinely replaced local state — and the toast fires exactly then.
 *
 * `site-reloaded` (replace-mode save — import/bootstrap) hands off to the
 * ordinary persistence reload path. `published` is informational.
 */
import type { SiteSyncEvent, SiteSyncTable } from '@core/persistence/syncEvents'
import { pushToast } from '@ui/components/Toast'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { useEditorStore } from '@site/store/store'
import type { RemoteSnapshot } from '@site/store/slices/site/types'
import { fetchRemoteSnapshot, type RemoteSnapshotTarget } from './remoteSnapshot'

/** Injectable fetch seam — tests hand in a fake that returns domain snapshots. */
export interface SiteSyncMergeDeps {
  fetchSnapshot: (target: RemoteSnapshotTarget) => Promise<RemoteSnapshot>
}

const defaultDeps: SiteSyncMergeDeps = { fetchSnapshot: fetchRemoteSnapshot }

function isTargetDirty(table: SiteSyncTable, rowId: string): boolean {
  const { _dirtySave } = useEditorStore.getState()
  if (_dirtySave.all) return true
  if (table === 'pages') {
    return _dirtySave.pageIds.has(rowId) || _dirtySave.deletedPageIds.has(rowId)
  }
  if (table === 'components') {
    return _dirtySave.componentIds.has(rowId) || _dirtySave.deletedComponentIds.has(rowId)
  }
  return _dirtySave.layoutIds.has(rowId) || _dirtySave.deletedLayoutIds.has(rowId)
}

/**
 * True when the target's only local dirtiness is its own pending DELETION —
 * a remote deletion of the same row is then agreement, not a conflict, and
 * merges silently (the apply clears the now-moot deleted mark).
 */
function isOnlyLocallyDeleted(table: SiteSyncTable, rowId: string): boolean {
  const { _dirtySave } = useEditorStore.getState()
  if (_dirtySave.all) return false
  if (table === 'pages') {
    return _dirtySave.deletedPageIds.has(rowId) && !_dirtySave.pageIds.has(rowId)
  }
  if (table === 'components') {
    return _dirtySave.deletedComponentIds.has(rowId) && !_dirtySave.componentIds.has(rowId)
  }
  return _dirtySave.deletedLayoutIds.has(rowId) && !_dirtySave.layoutIds.has(rowId)
}

/** Local display title of a row — for the remote-change toasts. */
function localRowTitle(table: SiteSyncTable, rowId: string): string | null {
  const site = useEditorStore.getState().site
  if (!site) return null
  if (table === 'pages') return site.pages.find((p) => p.id === rowId)?.title ?? null
  if (table === 'components') {
    return site.visualComponents.find((vc) => vc.id === rowId)?.name ?? null
  }
  return site.layouts.find((layout) => layout.id === rowId)?.name ?? null
}

async function handleRowEvent(
  table: SiteSyncTable,
  rowId: string,
  seq: number,
  deletedRemotely: boolean,
  actorName: string | undefined,
  deps: SiteSyncMergeDeps,
): Promise<void> {
  const store = useEditorStore.getState()
  if ((store.baseSeqs[rowId] ?? -1) >= seq) return // own write / already applied
  if (isTargetDirty(table, rowId)) {
    // Exception: both sides deleted the row — agreement merges silently.
    if (!(deletedRemotely && isOnlyLocallyDeleted(table, rowId))) {
      store.addSaveConflicts([{ table, rowId, seq }])
      return
    }
  }

  const wasActivePage = table === 'pages' && store.activePageId === rowId
  const title = localRowTitle(table, rowId)

  let snapshot: RemoteSnapshot
  if (deletedRemotely) {
    // No fetch — the snapshot is synchronous, so nothing can interleave
    // between the dirty check above and the apply below.
    snapshot = { table, rowId, row: null, seq }
  } else {
    snapshot = await deps.fetchSnapshot({ table, rowId, seq })
    // An edit may have landed while the fetch was on the wire — a dirty
    // target must never be silently overwritten, so it degrades to a conflict.
    if (isTargetDirty(table, rowId)) {
      useEditorStore.getState().addSaveConflicts([{ table, rowId, seq }])
      return
    }
  }

  const result = useEditorStore.getState().applyRemoteSnapshot(snapshot)
  if (!result.applied) return

  const who = actorName ?? 'Another admin'
  if (snapshot.table !== 'site' && snapshot.row === null && wasActivePage) {
    pushToast({
      kind: 'info',
      title: 'Page deleted',
      body: `${who} deleted ${title ? `"${title}"` : 'the page you were viewing'}.`,
    })
  } else if (result.clearedHistory) {
    pushToast({
      kind: 'info',
      title: 'Updated with newer changes',
      body: `${who} saved ${title ? `"${title}"` : 'content you have open'} — your undo history was reset.`,
    })
  }
}

async function handleShellEvent(
  seq: number,
  actorName: string | undefined,
  deps: SiteSyncMergeDeps,
): Promise<void> {
  const store = useEditorStore.getState()
  if (store.shellBaseSeq >= seq) return
  if (store._dirtySave.shell || store._dirtySave.all) {
    store.addSaveConflicts([{ table: 'site', rowId: 'default', seq }])
    return
  }

  const snapshot = await deps.fetchSnapshot({ table: 'site', rowId: 'default', seq })
  const after = useEditorStore.getState()
  if (after._dirtySave.shell || after._dirtySave.all) {
    after.addSaveConflicts([{ table: 'site', rowId: 'default', seq }])
    return
  }

  const result = after.applyRemoteSnapshot(snapshot)
  if (result.applied && result.clearedHistory) {
    pushToast({
      kind: 'info',
      title: 'Site settings updated',
      body: `${actorName ?? 'Another admin'} changed site settings or styles — your undo history was reset.`,
    })
  }
}

/** Apply one validated sync event to the editor store (see module doc). */
export async function processSiteSyncEvent(
  event: SiteSyncEvent,
  deps: SiteSyncMergeDeps = defaultDeps,
): Promise<void> {
  switch (event.kind) {
    case 'rows-changed':
    case 'rows-deleted': {
      const deletedRemotely = event.kind === 'rows-deleted'
      for (const [rowId, seq] of Object.entries(event.seqs)) {
        await handleRowEvent(event.table, rowId, seq, deletedRemotely, event.actor?.name, deps)
      }
      useEditorStore.getState().advanceSyncCursor(Math.max(...Object.values(event.seqs), 0))
      break
    }
    case 'shell-changed': {
      await handleShellEvent(event.seq, event.actor?.name, deps)
      useEditorStore.getState().advanceSyncCursor(event.seq)
      break
    }
    case 'site-reloaded': {
      const store = useEditorStore.getState()
      if (store.syncCursor >= event.seq) break
      store.advanceSyncCursor(event.seq)
      pushToast({
        kind: 'info',
        title: 'Site replaced',
        body: `${event.actor?.name ?? 'Another admin'} replaced the site (import) — reloading the editor.`,
      })
      // The ordinary reload path refetches, revalidates, and reseeds the
      // sync bases; local unsaved edits are moot against a replaced site.
      requestCmsSiteReload()
      break
    }
    case 'published':
      // Informational — no editor state derives from the publish version yet.
      break
  }
}
