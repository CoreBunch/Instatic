import type { DataField, DataFieldType, DataRowCells } from '@core/data/schemas'
import type { FieldLocalization } from '@core/localization-schema'
import { parsePageNodeTree } from '@core/page-tree'
import { deepEqual } from '@core/utils/deepEqual'
import { cloneContentValue } from './contentValues'
import { parseVisualComponent } from '@core/visualComponents'
import { LocalizationValidationError } from './errors'
import { localizableParameterIdsFromCells } from './parameters'
import { extractLocalizedTreeChanges, materializeLocalizedTree, parseLocaleTreeCell, splitLocalizedTree, localizedObject, captureLocalizedObjectChanges, type PropertyLocalizationPolicy } from './trees'

const LOCALIZED_FIELD_TYPES: ReadonlySet<DataFieldType> = new Set([
  'text', 'longText', 'richText', 'url', 'media', 'repeater', 'pageTree', 'parameterValues',
])

/** Schema annotations win over the default for existing unannotated fields. */
export function resolveDataFieldLocalization(field: DataField): FieldLocalization {
  return field.localization ?? defaultDataFieldLocalization(field.type)
}

export function defaultDataFieldLocalization(type: DataFieldType): FieldLocalization {
  return LOCALIZED_FIELD_TYPES.has(type) ? 'localized' : 'shared'
}

/**
 * Resolve a draft or freeze a complete live snapshot from the same inputs.
 * Shared fields come exclusively from the logical row. Localized fields use
 * target values first, then source values; old localized scalar values left
 * in the logical row are never a fallback. Missing stays missing, while null,
 * false, zero and empty strings/arrays remain explicit local values.
 *
 * Tree cells are the exception to scalar merging: their structure always
 * comes from the logical row and both locales supply sparse value overrides.
 * Availability is intentionally not resolved here: callers must select an
 * explicitly published variant before exposing any public content.
 */
export function materializeLocalizedCells(
  fields: readonly DataField[],
  sharedCells: DataRowCells,
  sourceCells: DataRowCells,
  localeCells: DataRowCells,
): DataRowCells {
  const fieldIds = new Set(fields.map((field) => field.id))
  const entries: [string, unknown][] = Object.entries(sharedCells)
    .filter(([key]) => !fieldIds.has(key))
    .map(([key, value]) => [key, cloneContentValue(value)])
  for (const field of fields) {
    const key = field.id
    if (resolveDataFieldLocalization(field) === 'shared') {
      if (Object.hasOwn(sharedCells, key)) {
        entries.push([key, field.type === 'pageTree'
          ? parsePageNodeTree(cloneContentValue(sharedCells[key]), key)
          : cloneContentValue(sharedCells[key])])
      }
      continue
    }

    if (field.type === 'parameterValues') {
      entries.push([key, { ...localizedObject(sourceCells[key]), ...localizedObject(localeCells[key]) }])
      continue
    }

    if (field.type === 'pageTree') {
      if (!Object.hasOwn(sharedCells, key)) {
        if (Object.hasOwn(sourceCells, key) || Object.hasOwn(localeCells, key)) {
          throw new LocalizationValidationError(key, 'Localized tree values require a shared tree.')
        }
        continue
      }
      const sharedTree = parsePageNodeTree(cloneContentValue(sharedCells[key]), key)
      const source = parseLocaleTreeCell(Object.hasOwn(sourceCells, key) ? sourceCells[key] : undefined, key)
      const locale = parseLocaleTreeCell(Object.hasOwn(localeCells, key) ? localeCells[key] : undefined, key)
      entries.push([key, materializeLocalizedTree(sharedTree, source.nodes, locale.nodes)])
      continue
    }

    if (Object.hasOwn(localeCells, key)) {
      entries.push([key, cloneContentValue(localeCells[key])])
    } else if (Object.hasOwn(sourceCells, key)) {
      entries.push([key, cloneContentValue(sourceCells[key])])
    }
  }
  return Object.fromEntries(entries)
}

/**
 * Split an edited projection back into logical fields and sparse locale
 * fields. Untouched inherited content is never copied into the target locale.
 * Unknown logical metadata is retained; unknown input fields are not adopted.
 */
export function splitLocalizedCells(
  fields: readonly DataField[],
  previousSharedCells: DataRowCells,
  previousProjection: DataRowCells,
  nextProjection: DataRowCells,
  previousLocaleCells: DataRowCells,
  options: {
    canLocalizeProperty?: PropertyLocalizationPolicy
    allowStructureChanges?: boolean
  } = {},
): { sharedCells: DataRowCells; localeCells: DataRowCells } {
  const sharedCells = cloneContentValue(previousSharedCells)
  const localeCells = cloneContentValue(previousLocaleCells)
  for (const field of fields) {
    const key = field.id
    const hadValue = Object.hasOwn(previousProjection, key)
    const hasValue = Object.hasOwn(nextProjection, key)
    if (hadValue === hasValue && deepEqual(previousProjection[key], nextProjection[key])) continue
    const localized = resolveDataFieldLocalization(field) === 'localized'

    if (localized && field.type === 'pageTree') {
      if (!options.canLocalizeProperty) {
        throw new LocalizationValidationError(key, 'A module property localization policy is required to edit a tree.')
      }
      if (!hasValue) throw new LocalizationValidationError(key, 'The shared tree cannot be removed from a translation.')
      const after = parsePageNodeTree(cloneContentValue(nextProjection[key]), key)
      const previous = parseLocaleTreeCell(Object.hasOwn(previousLocaleCells, key) ? previousLocaleCells[key] : undefined, key)
      const before = hadValue ? parsePageNodeTree(cloneContentValue(previousProjection[key]), key) : { rootNodeId: after.rootNodeId, nodes: {} }
      if (options.allowStructureChanges) {
        const shared = Object.hasOwn(previousSharedCells, key)
          ? parsePageNodeTree(cloneContentValue(previousSharedCells[key]), key)
          : { rootNodeId: after.rootNodeId, nodes: {} }
        const split = splitLocalizedTree(shared, before, after, previous.nodes, options.canLocalizeProperty)
        Object.defineProperty(sharedCells, key, {
          value: split.sharedTree, enumerable: true, configurable: true, writable: true,
        })
        Object.defineProperty(localeCells, key, {
          value: { nodes: split.localeOverrides }, enumerable: true, configurable: true, writable: true,
        })
      } else {
        Object.defineProperty(localeCells, key, {
          value: { nodes: extractLocalizedTreeChanges(before, after, previous.nodes, options.canLocalizeProperty) },
          enumerable: true, configurable: true, writable: true,
        })
      }
      continue
    }

    if (key === 'params' && fields.some((candidate) => candidate.type === 'parameterValues')) {
      const allowed = localizableParameterIdsFromCells(nextProjection)
      const beforeComponent = parseVisualComponent({ id: 'before', name: 'Before', createdAt: 0, tree: previousSharedCells.body, params: previousSharedCells.params ?? [], classIds: [] })
      const afterComponent = parseVisualComponent({ id: 'after', name: 'After', createdAt: 0, tree: nextProjection.body, params: nextProjection.params ?? [], classIds: [] })
      if (!afterComponent) throw new LocalizationValidationError('params', 'Invalid component parameters.')
      const previousParams = new Map(beforeComponent?.params.map((parameter) => [parameter.id, parameter]) ?? [])
      sharedCells.params = afterComponent.params.map((parameter) => allowed.has(parameter.id)
        ? { ...parameter, defaultValue: previousParams.has(parameter.id) ? previousParams.get(parameter.id)!.defaultValue : '' } : parameter)
      continue
    }
    if (localized && field.type === 'parameterValues') {
      const allowed = localizableParameterIdsFromCells(nextProjection)
      localeCells[key] = captureLocalizedObjectChanges(previousProjection[key], nextProjection[key], previousLocaleCells[key], allowed)
      continue
    }

    const destination = localized ? localeCells : sharedCells
    if (hasValue && nextProjection[key] !== undefined) {
      Object.defineProperty(destination, key, {
        value: cloneContentValue(nextProjection[key]), enumerable: true, configurable: true, writable: true,
      })
    } else {
      delete destination[key]
    }
  }
  for (const field of fields) {
    if (resolveDataFieldLocalization(field) !== 'localized' || !Object.hasOwn(localeCells, field.id)) continue
    if (field.type === 'pageTree' && Object.keys(parseLocaleTreeCell(localeCells[field.id], field.id).nodes).length === 0) {
      delete localeCells[field.id]
    } else if (field.type === 'parameterValues' && Object.keys(localizedObject(localeCells[field.id])).length === 0) {
      delete localeCells[field.id]
    }
  }
  return { sharedCells, localeCells }
}
