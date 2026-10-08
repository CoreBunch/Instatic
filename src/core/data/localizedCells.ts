import { canonicalLanguage, LocalizationError, resolveTranslation, resolveSiteLanguage } from '@core/localization'
import { LocalizedTextReferenceSchema, type LocalizedTextReference } from '@core/localization-schema'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { RepeaterValueSchema, type DataField, type DataRowCells, type RepeaterItemField, type RepeaterValue } from './schemas'

export type DataLocalizationContext = ReturnType<typeof resolveSiteLanguage>

export class LocalizedDataReferenceAccessError extends LocalizationError {
  constructor(path: string) {
    super(path, 'Choose a language-catalogue key authorized for this content, or request Site access to browse new keys')
    this.name = 'LocalizedDataReferenceAccessError'
  }
}

/** Null is an empty authorable cell; any present reference must conform exactly. */
export function readLocalizedTextReference(value: unknown, path: string): LocalizedTextReference | null {
  if (value === undefined || value === null) return null
  const parsed = safeParseValue(LocalizedTextReferenceSchema, value)
  if (!parsed.ok) {
    throw new LocalizationError(path, 'Expected a language-catalogue text reference')
  }
  return parsed.value
}

/** Shared by authoring, collection queries and loop projection; never chooses another language. */
export function resolveLocalizedTextValue(value: unknown, context: DataLocalizationContext, path: string): string | null {
  const reference = readLocalizedTextReference(value, path)
  if (!reference) return null
  try {
    return resolveTranslation(context.translations, reference.key, canonicalLanguage(context.language))
  } catch (cause) {
    throw new LocalizationError(path, `Cannot resolve language-catalogue key "${reference.key}"`, cause)
  }
}

export function hasLocalizedDataFields(fields: readonly DataField[]): boolean {
  return fields.some(field => field.type === 'localizedText' ||
    (field.type === 'repeater' && field.fields.some(item => item.type === 'localizedText')))
}

/** Missing draft values are empty; a present ordered value must conform exactly. */
export function readDataRepeaterValue(value: unknown, path: string): RepeaterValue {
  if (value === undefined || value === null) return []
  const parsed = safeParseValue(RepeaterValueSchema, value)
  if (!parsed.ok) throw new LocalizationError(path, 'Expected an ordered repeater value')
  const ids = new Set<string>()
  for (const item of parsed.value) {
    if (!item.id || ids.has(item.id)) throw new LocalizationError(path, 'Ordered repeater items require distinct nonempty identities')
    ids.add(item.id)
  }
  return parsed.value
}

/** Validation and permission checks inspect the same exact stored references. */
export function localizedDataReferences(cells: DataRowCells, fields: readonly DataField[], path: string): Map<string, string> {
  const references = new Map<string, string>()
  for (const field of fields) {
    const fieldPath = `${path}.${field.id}`
    if (field.type === 'localizedText') {
      const reference = readLocalizedTextReference(cells[field.id], fieldPath)
      if (reference) references.set(fieldPath, reference.key)
    } else if (field.type === 'repeater' && field.fields.some(item => item.type === 'localizedText')) {
      for (const item of readDataRepeaterValue(cells[field.id], fieldPath)) {
        for (const [referencePath, key] of localizedDataReferences(item.cells, field.fields, `${fieldPath}.${item.id}.cells`)) {
          references.set(referencePath, key)
        }
      }
    }
  }
  return references
}

export function assertLocalizedDataReferenceAccess(cells: DataRowCells, fields: readonly DataField[], allowedKeys: ReadonlySet<string>, path: string): void {
  for (const [referencePath, key] of localizedDataReferences(cells, fields, path)) {
    if (!allowedKeys.has(key)) throw new LocalizedDataReferenceAccessError(referencePath)
  }
}

/** Locale-aware scalar ordering, empty values last in both directions; callers own ID ties. */
export function compareDataCellValues(a: unknown, b: unknown, language?: string, direction: 'asc' | 'desc' = 'asc'): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  const comparison = typeof a === 'number' && typeof b === 'number' ? a - b
    : typeof a === 'boolean' && typeof b === 'boolean' ? Number(a) - Number(b)
    : String(a).localeCompare(String(b), language, { numeric: true, sensitivity: 'base' })
  return direction === 'desc' ? -comparison : comparison
}

function projectItemCells(
  cells: DataRowCells,
  fields: readonly RepeaterItemField[],
  context: DataLocalizationContext,
  path: string,
): DataRowCells {
  const projected = { ...cells }
  for (const field of fields) {
    if (field.type === 'localizedText') {
      projected[field.id] = resolveLocalizedTextValue(cells[field.id], context, `${path}.${field.id}`)
    }
  }
  return projected
}

/** Derived display/query values leave stored cells and stable repeater identities unchanged. */
export function projectLocalizedDataCells(
  cells: DataRowCells,
  fields: readonly DataField[],
  context: DataLocalizationContext,
  path: string,
): DataRowCells {
  if (!hasLocalizedDataFields(fields)) return cells
  const projected = { ...cells }
  for (const field of fields) {
    const fieldPath = `${path}.${field.id}`
    if (field.type === 'localizedText') {
      projected[field.id] = resolveLocalizedTextValue(cells[field.id], context, fieldPath)
    } else if (field.type === 'repeater' && field.fields.some(item => item.type === 'localizedText')) {
      const value = cells[field.id]
      if (value === undefined || value === null) continue
      projected[field.id] = readDataRepeaterValue(value, fieldPath).map(item => ({
        ...item,
        cells: projectItemCells(item.cells, field.fields, context, `${fieldPath}.${item.id}.cells`),
      }))
    }
  }
  return projected
}
