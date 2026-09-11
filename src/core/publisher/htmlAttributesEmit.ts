/**
 * Publisher string emit for author-supplied `htmlAttributes` prop bags.
 *
 * Normalisation and sanitisation live in `@core/htmlAttributes` (the single
 * security gate); this file owns only the publish-side serialisation into a
 * ` name="value"` string, escaped with the publisher's canonical escapeHtml.
 */
import { normalizeHtmlAttributes } from '@core/htmlAttributes'
import { escapeHtml } from './utils'

export function htmlAttributesAttr(value: unknown): string {
  return Object.entries(normalizeHtmlAttributes(value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, attrValue]) => ` ${name}="${escapeHtml(attrValue)}"`)
    .join('')
}
