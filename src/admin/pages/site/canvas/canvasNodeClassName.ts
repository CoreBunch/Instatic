import type { ClassPreviewAssignment } from '@site/store/slices/styleRuleSlice'
import { classNamesForClassIds, type StyleRuleRegistry } from '@core/page-tree'

export function getCanvasNodeClassIds(
  classIds: readonly string[] | undefined,
  previewClassAssignment: ClassPreviewAssignment | null,
  nodeId: string,
): readonly string[] | undefined {
  const previewClassId =
    previewClassAssignment?.nodeId === nodeId &&
    !classIds?.includes(previewClassAssignment.classId)
      ? previewClassAssignment.classId
      : null

  if (previewClassId === null) {
    // No preview to merge — pass the node's own (store-immutable) list
    // through. This runs in a per-node selector on every store set, so
    // copying here would allocate O(nodes) arrays per store change.
    return classIds && classIds.length > 0 ? classIds : undefined
  }

  return classIds ? [...classIds, previewClassId] : [previewClassId]
}

export function getCanvasNodeClassName(
  classIds: readonly string[] | undefined,
  previewClassAssignment: ClassPreviewAssignment | null,
  nodeId: string,
  classes: StyleRuleRegistry,
): string | undefined {
  const names = classNamesForClassIds(
    classes,
    getCanvasNodeClassIds(classIds, previewClassAssignment, nodeId),
  )
  return names.length > 0 ? names.join(' ') : undefined
}
