import type { DataField } from '@core/data/schemas'
import type { ContentLocalizationDraftInput } from '@core/localization-schema'
import { getLocalizablePropertyKeys, parseLocaleTreeCell, resolveDataFieldLocalization } from '@core/localization'
import { parsePageNodeTree } from '@core/page-tree'
import { localizableComponentParameterIds, readComponentParameterValues, type VisualComponent } from '@core/visualComponents'
import { localizableParameterIdsFromCells } from '@core/localization'
import { registry } from '@core/module-engine'
import { deepEqual } from '@core/utils/deepEqual'

export type LocalizationGuardContext = {
  fields: DataField[]
  sharedCells: Record<string, unknown>
  components?: VisualComponent[]
}

/** Only localized fields and content properties may cross a locale document. */
export function validateLocalizationDraftChange(
  previous: ContentLocalizationDraftInput,
  next: ContentLocalizationDraftInput,
  context: LocalizationGuardContext,
): string | null {
  const fields = new Map(context.fields.map((field) => [field.id, field]))
  if (previous.slug !== next.slug && resolveDataFieldLocalization(fields.get('slug') ?? { id: 'slug', label: 'Slug', type: 'text' }) !== 'localized') {
    return 'Shared slugs cannot be changed in a language document'
  }
  for (const key of new Set([...Object.keys(previous.cells), ...Object.keys(next.cells)])) {
    if (Object.hasOwn(previous.cells, key) === Object.hasOwn(next.cells, key) && deepEqual(previous.cells[key], next.cells[key])) continue
    const field = fields.get(key)
    if (!field || resolveDataFieldLocalization(field) !== 'localized') return `Field ${key} is shared or unknown`
    if (field.type === 'parameterValues') {
      const allowed = localizableParameterIdsFromCells(context.sharedCells)
      for (const [parameter, value] of Object.entries(readComponentParameterValues(next.cells[key]))) {
        if (!allowed.has(parameter) || (value !== null && typeof value !== 'string')) return `Invalid localized parameter ${parameter}`
      }
      continue
    }
    if (field.type !== 'pageTree' || !Object.hasOwn(next.cells, key)) continue
    const before = parseLocaleTreeCell(previous.cells[key], key)
    const after = parseLocaleTreeCell(next.cells[key], key)
    const shared = parsePageNodeTree(structuredClone(context.sharedCells[key]), key)
    for (const [nodeId, override] of Object.entries(after.nodes)) {
      if (deepEqual(before.nodes[nodeId], override)) continue
      const node = shared.nodes[nodeId]
      if (!node) return `Unknown shared node ${nodeId}`
      const module = registry.get(node.moduleId)
      const contentProps = module ? getLocalizablePropertyKeys(module.schema) : new Set<string>()
      for (const property of Object.keys(override.props ?? {})) {
        if (deepEqual(before.nodes[nodeId]?.props?.[property], override.props?.[property])) continue
        if (node.moduleId === 'base.visual-component-ref' && property === 'propOverrides') {
          const component = context.components?.find((entry) => entry.id === node.props.componentId)
          if (!component) return 'Unknown referenced component'
          const allowed = localizableComponentParameterIds(component)
          for (const [parameter, value] of Object.entries(readComponentParameterValues(override.props?.[property]))) {
            if (!allowed.has(parameter) || (value !== null && typeof value !== 'string')) return `Invalid localized parameter ${parameter}`
          }
          continue
        }
        if (!contentProps.has(property)) return `Property ${nodeId}.${property} is shared`
      }
    }
  }
  return null
}
