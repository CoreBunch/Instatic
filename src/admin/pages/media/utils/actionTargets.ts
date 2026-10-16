/**
 * Which assets an action on one tile applies to — the Finder rule.
 *
 * Acting on an item inside the selection acts on the whole selection; acting
 * on one outside it acts on that item alone, so right-clicking away from a
 * selection starts a new, unrelated action instead of sweeping the old
 * selection in. Dragging and the context menu both resolve their ids here,
 * so the same tile can never drag one set of files and delete another.
 */
export function actionTargets(clickedId: string, selectedIds: ReadonlySet<string>): string[] {
  return selectedIds.has(clickedId) ? [...selectedIds] : [clickedId]
}
