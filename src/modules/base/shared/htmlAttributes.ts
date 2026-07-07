import type { PropertyControl } from '@core/module-engine'
import {
  normalizeHtmlAttributeName,
  sanitizeRenderableHtmlAttribute,
} from '@core/htmlAttributes'
import { escapeHtml } from '@modules/base/utils/escape'

export const HtmlAttributesPropSchemaOptions = { default: {} } as const

export function htmlAttributesControl(): PropertyControl {
  return {
    type: 'group',
    label: 'HTML attributes',
    hidden: true,
    children: {},
  }
}

function normalizeHtmlAttributes(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const attrs: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== 'string') continue
    const name = normalizeHtmlAttributeName(rawName)
    const safeValue = sanitizeRenderableHtmlAttribute(name, rawValue)
    if (safeValue === null) continue
    attrs[name] = safeValue
  }
  return attrs
}

export function htmlAttributesAttr(value: unknown): string {
  const attrs = normalizeHtmlAttributes(value)
  return Object.entries(attrs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, attrValue]) => ` ${name}="${escapeHtml(attrValue)}"`)
    .join('')
}

export function htmlAttributesForReact(value: unknown): Record<string, string> {
  return normalizeHtmlAttributes(value)
}
