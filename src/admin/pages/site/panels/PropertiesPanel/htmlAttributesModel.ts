import {
  isEventHandlerAttributeName,
  isRenderableHtmlAttributeName,
  isReservedRuntimeDataAttributeName,
  normalizeHtmlAttributeName,
} from '@core/htmlAttributes'

export interface HtmlAttributeDraftRow {
  id: string
  name: string
  value: string
}

interface HtmlAttributeValidationResult {
  attributes: Record<string, string>
  errors: Record<string, string>
}

export function htmlAttributeRowsFromValue(value: unknown): HtmlAttributeDraftRow[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []

  const rows: HtmlAttributeDraftRow[] = []
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== 'string') continue
    const name = normalizeHtmlAttributeName(rawName)
    if (!isRenderableHtmlAttributeName(name)) continue
    rows.push({ id: name, name, value: rawValue })
  }

  return rows
}

export function validateHtmlAttributeRows(
  rows: ReadonlyArray<HtmlAttributeDraftRow>,
): HtmlAttributeValidationResult {
  const attributes: Record<string, string> = {}
  const errors: Record<string, string> = {}
  const seen = new Set<string>()

  for (const row of rows) {
    const name = normalizeHtmlAttributeName(row.name)
    const hasName = name.length > 0
    const hasValue = row.value.length > 0

    if (!hasName && !hasValue) continue

    if (!hasName) {
      errors[row.id] = 'Add an attribute name.'
      continue
    }

    if (!isRenderableHtmlAttributeName(name)) {
      errors[row.id] = htmlAttributeNameError(name)
      continue
    }

    if (seen.has(name)) {
      errors[row.id] = 'Attribute names must be unique.'
      continue
    }

    seen.add(name)
    attributes[name] = row.value
  }

  return { attributes, errors }
}

export function htmlAttributesKey(attributes: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(attributes).toSorted(([a], [b]) => a.localeCompare(b)),
  )
}

export function htmlAttributesValueKey(value: unknown): string {
  const rows = htmlAttributeRowsFromValue(value)
  const attributes = Object.fromEntries(rows.map((row) => [row.name, row.value]))
  return htmlAttributesKey(attributes)
}

function htmlAttributeNameError(name: string): string {
  if (name === 'class') return 'Classes are managed in Styles.'
  if (name === 'style') return 'Inline styles are managed in Styles.'
  if (isEventHandlerAttributeName(name)) return 'Event handler attributes are not allowed.'
  if (isReservedRuntimeDataAttributeName(name)) return 'This attribute is reserved by the editor.'
  return 'Use a safe HTML attribute name.'
}
