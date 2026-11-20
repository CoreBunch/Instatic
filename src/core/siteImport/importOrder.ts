/**
 * Load order of an import's scripts (or kept stylesheets) inside the site's.
 *
 * An import numbers its own files `100, 101, …` (`scriptOrder.ts`,
 * `stylesheetPlan.ts`). Those numbers rank the import's files against each
 * other only, so they can never be copied onto a site that already has files:
 * re-importing one page would tie or reorder files other pages load. Instead
 * the store merges the import's order into the site's existing order and
 * renumbers only when the merged order needs it.
 */

/**
 * One load order holding every site file and every file of this import.
 *
 * Files outside the import keep their place. The import's files that the
 * site already had mark the slots the import may use; the import's files fill
 * those slots in the import's own order, and a file new in this import goes
 * into the slot of the next already-present file after it (or after the last
 * slot). So among the import's files the import's order wins, and every
 * other file keeps its position relative to the rest. With no already-present
 * file the import's files follow the site's.
 *
 * @param siteOrder the site's files in today's load order, excluding files
 *                  this import just added.
 * @param importOrder this import's files (added, replaced and reused) in the
 *                    import's own order.
 */
export function mergeImportOrder(siteOrder: readonly string[], importOrder: readonly string[]): string[] {
  const inSite = new Set(siteOrder)
  const groups: string[][] = []
  let pending: string[] = []
  for (const id of importOrder) {
    pending.push(id)
    if (inSite.has(id)) {
      groups.push(pending)
      pending = []
    }
  }
  if (groups.length === 0) return [...siteOrder, ...pending]
  groups[groups.length - 1]!.push(...pending)

  const imported = new Set(importOrder)
  const merged: string[] = []
  let slot = 0
  for (const id of siteOrder) {
    if (imported.has(id)) merged.push(...groups[slot++]!)
    else merged.push(id)
  }
  return merged
}

/** Start and step of a fresh numbering, leaving room to slot files in later. */
const FIRST_PRIORITY = 100
const PRIORITY_STEP = 10

/**
 * Priorities that make `sequence` load in exactly that order, with no ties.
 *
 * Files keep their current priority when the order allows it, and a file
 * without one (new in this import) takes the next free number before its
 * successor. Only when that cannot give a strictly increasing sequence is the
 * whole sequence renumbered with gaps. Never relies on the runtime's path
 * tie-break.
 *
 * @returns the priority of every file in `sequence` (unchanged ones included).
 */
export function prioritiesForOrder(
  sequence: readonly string[],
  current: ReadonlyMap<string, number>,
): Map<string, number> {
  const kept = new Map<string, number>()
  const firstExisting = sequence.find((id) => current.has(id))
  let nextPriority = firstExisting === undefined ? FIRST_PRIORITY : current.get(firstExisting)! - PRIORITY_STEP
  let previous = Number.NEGATIVE_INFINITY
  for (const id of sequence) {
    const priority = current.get(id) ?? nextPriority
    if (priority <= previous) return renumbered(sequence)
    kept.set(id, priority)
    previous = priority
    nextPriority = priority + 1
  }
  return kept
}

function renumbered(sequence: readonly string[]): Map<string, number> {
  return new Map(sequence.map((id, i) => [id, FIRST_PRIORITY + i * PRIORITY_STEP]))
}
