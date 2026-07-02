/**
 * fetchRemoteSnapshot — pull the CURRENT server state of one sync target and
 * convert it to the domain shape `applyRemoteSnapshot` consumes.
 *
 * Shared by the conflict banner's "Load theirs" and the live-sync socket's
 * clean-target pull. Row targets ride the collection GETs' single-row `?id=`
 * filter; absence (`row: null`) IS the "deleted remotely" signal. The shell
 * rides `GET /site`, which carries its sync seq.
 *
 * The returned seq prefers the FETCHED row's seq over the triggering
 * event/conflict seq — the row may have moved further since.
 */
import { cmsAdapter } from '@core/persistence/cms'
import { pageFromRow } from '@core/data/pageFromRow'
import { visualComponentFromRow } from '@core/data/componentFromRow'
import { savedLayoutFromRow } from '@core/data/layoutFromRow'
import type { RemoteSnapshot } from '@site/store/slices/site/types'

export interface RemoteSnapshotTarget {
  table: 'site' | 'pages' | 'components' | 'layouts'
  rowId: string
  /** The seq that triggered the fetch — fallback when the target is deleted. */
  seq: number
}

/** Row snapshot — the variants of {@link RemoteSnapshot} that carry a `row`. */
export type RemoteRowSnapshot = Exclude<RemoteSnapshot, { table: 'site' }>

// Overloads: a row-table target provably yields a row snapshot, so callers
// that never fetch the shell (the socket's row handler) get the narrow type.
export async function fetchRemoteSnapshot(
  target: RemoteSnapshotTarget & { table: RemoteRowSnapshot['table'] },
): Promise<RemoteRowSnapshot>
export async function fetchRemoteSnapshot(target: RemoteSnapshotTarget): Promise<RemoteSnapshot>
export async function fetchRemoteSnapshot(target: RemoteSnapshotTarget): Promise<RemoteSnapshot> {
  if (target.table === 'site') {
    const remote = await cmsAdapter.loadSiteShell()
    if (!remote) throw new Error('The site shell no longer exists on the server.')
    return { table: 'site', shell: remote.shell, seq: remote.seq }
  }
  const row = await cmsAdapter.loadSiteRow(target.table, target.rowId)
  const seq = row?.seq ?? target.seq
  if (target.table === 'pages') {
    return { table: 'pages', rowId: target.rowId, row: row ? pageFromRow(row) : null, seq }
  }
  if (target.table === 'components') {
    return {
      table: 'components',
      rowId: target.rowId,
      row: row ? visualComponentFromRow(row) : null,
      seq,
    }
  }
  return { table: 'layouts', rowId: target.rowId, row: row ? savedLayoutFromRow(row) : null, seq }
}
