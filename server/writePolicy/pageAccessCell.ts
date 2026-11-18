/**
 * A page's access rule is stored as the `access` cell of its row. Changing it
 * is a structural decision (`site.structure.edit`, enforced for the editor's
 * own saves in `pageDiff.ts`), but a page is also a row, and rows can be
 * written through the generic content paths: the Data and Content workspaces,
 * plugin content calls, the AI content tools.
 *
 * Those paths replace a row's cells wholesale, so a caller that simply left
 * `access` out would open a protected page to everyone. Every such path runs
 * its cells through `keepPageAccess`, which puts the stored rule back unless
 * the caller is allowed to change it.
 */
/** The system table that holds pages. */
const PAGES_TABLE_ID = 'pages'

export function keepPageAccess(
  stored: { tableId: string; cells: Record<string, unknown> },
  nextCells: Record<string, unknown>,
  mayChangeAccess = false,
): Record<string, unknown> {
  if (stored.tableId !== PAGES_TABLE_ID || mayChangeAccess) return nextCells
  const { access: _attempted, ...rest } = nextCells
  return stored.cells.access === undefined ? rest : { ...rest, access: stored.cells.access }
}
