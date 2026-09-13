/**
 * Pure helper that diffs the new manifest's `contentAccess[]` allowlist
 * against the previously-installed manifest's on an upgrade. Lives in its
 * own file (like `computePermissionDiff`) so the `.tsx` component file
 * stays Fast-Refresh-friendly.
 *
 * Rows are keyed by table:
 *
 *   • `new`      — table not previously declared, OR previously declared
 *                  but the update requests modes the operator never
 *                  approved for it (`addedModes` lists them). Both are
 *                  access the operator has not yet consented to.
 *   • `existing` — table previously declared with no new modes (a shrunk
 *                  mode set still counts as existing — the row shows
 *                  exactly what the new manifest requests).
 *   • `dropped`  — table previously declared but absent from the new
 *                  manifest; the row shows the previously-declared modes.
 *
 * Order of rows: new first (most important to surface), existing second,
 * dropped last — same ordering the permission and host diffs use.
 */
import type { ContentAccessEntry, ContentAccessMode } from '@core/plugin-sdk'

/**
 * Marker value in `contentAccess[].table` that stands for "every table this
 * plugin itself creates at runtime" instead of a concrete table slug. The
 * consent screen renders it as a human-readable phrase ("Tables this plugin
 * creates") rather than a literal slug.
 */
export const OWN_CREATED_CONTENT_TABLE = '@own-created'

export function isOwnCreatedContentTable(table: string): boolean {
  return table === OWN_CREATED_CONTENT_TABLE
}

export type ContentAccessDiffStatus = 'new' | 'existing' | 'dropped'

export interface ContentAccessDiffRow {
  table: string
  /**
   * Modes the row displays, in canonical read → write → publish → delete
   * order: the requested modes for `new` / `existing` rows, the
   * previously-declared modes for `dropped` rows.
   */
  modes: ContentAccessMode[]
  /**
   * Upgrade only: modes newly requested on a table the operator already
   * approved. Non-empty exactly when an already-approved table was promoted
   * to `new` — a brand-new table row keeps this empty because the whole row
   * is new access.
   */
  addedModes: ContentAccessMode[]
  status: ContentAccessDiffStatus
}

const MODE_ORDER: Record<ContentAccessMode, number> = {
  read: 0,
  write: 1,
  publish: 2,
  delete: 3,
}

function sortModes(modes: readonly ContentAccessMode[]): ContentAccessMode[] {
  return [...modes].sort((a, b) => MODE_ORDER[a] - MODE_ORDER[b])
}

export function computeContentAccessDiff(
  next: readonly ContentAccessEntry[],
  previous: readonly ContentAccessEntry[] | undefined,
  isUpgrade: boolean,
): ContentAccessDiffRow[] {
  const previousByTable = new Map((previous ?? []).map((entry) => [entry.table, entry]))
  const nextTables = new Set(next.map((entry) => entry.table))

  const rows: ContentAccessDiffRow[] = []
  for (const entry of next) {
    const prior = isUpgrade ? previousByTable.get(entry.table) : undefined
    if (!prior) {
      rows.push({
        table: entry.table,
        modes: sortModes(entry.modes),
        addedModes: [],
        status: 'new',
      })
      continue
    }
    const priorModes = new Set(prior.modes)
    const addedModes = sortModes(entry.modes.filter((mode) => !priorModes.has(mode)))
    rows.push({
      table: entry.table,
      modes: sortModes(entry.modes),
      addedModes,
      status: addedModes.length > 0 ? 'new' : 'existing',
    })
  }
  if (isUpgrade) {
    for (const entry of previous ?? []) {
      if (!nextTables.has(entry.table)) {
        rows.push({
          table: entry.table,
          modes: sortModes(entry.modes),
          addedModes: [],
          status: 'dropped',
        })
      }
    }
  }
  const order: Record<ContentAccessDiffStatus, number> = { new: 0, existing: 1, dropped: 2 }
  return rows.sort(
    (a, b) => order[a.status] - order[b.status] || a.table.localeCompare(b.table),
  )
}
