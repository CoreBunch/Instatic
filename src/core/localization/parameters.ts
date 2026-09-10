import { localizableComponentParameterIds, parseVisualComponent } from '@core/visualComponents'

export function localizableParameterIdsFromCells(cells: Record<string, unknown>): ReadonlySet<string> {
  const component = parseVisualComponent({
    id: 'localization-policy', name: 'Localization policy', createdAt: 0,
    tree: cells.body, params: cells.params ?? [], classIds: cells.classIds ?? [],
  })
  return component ? localizableComponentParameterIds(component) : new Set()
}
