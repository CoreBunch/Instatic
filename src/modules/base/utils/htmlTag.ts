/**
 * Shared Properties-panel controls for modules that let the author pick which
 * semantic element they render as (`base.container`, `base.loop`,
 * `base.outlet`).
 *
 * The tag list, the 'custom' sentinel, and the `resolveHtmlTag` resolver live
 * in `@core/htmlAttributes` so the publisher can resolve tags without
 * depending on module code — this file only builds the `PropertyControl`
 * descriptors that surface those choices in the panel.
 */

import type { PropertyControl } from '@core/module-engine'
import { BUILTIN_HTML_TAGS, CUSTOM_HTML_TAG_VALUE } from '@core/htmlAttributes'

/**
 * The standard `select` control for picking from built-in tags + 'custom'.
 * Pair with `customHtmlTagControl()` (or a manual conditional renderer) to
 * surface the free-form text input when 'custom' is chosen.
 */
export function htmlTagControl(label: string = 'HTML tag'): PropertyControl {
  return {
    type: 'select',
    label,
    options: [
      ...BUILTIN_HTML_TAGS.map((t) => ({ label: t, value: t })),
      { label: 'Custom…', value: CUSTOM_HTML_TAG_VALUE },
    ],
  }
}

/**
 * The free-form text control shown only when `tag === 'custom'`.
 *
 * `field` defaults to `'tag'` to match the standard prop naming used by
 * Container + Loop; pass an alternate key if a module stores the tag select
 * under a different prop name.
 */
export function customHtmlTagControl(
  label: string = 'Custom tag',
  field: string = 'tag',
): PropertyControl {
  return {
    type: 'text',
    label,
    placeholder: 'e.g. aside, figure, my-widget',
    condition: { field, eq: CUSTOM_HTML_TAG_VALUE },
    // The tag is structural, not content — keep it under `site.structure.edit`
    // even though `text` controls default to 'content'.
    category: 'layout',
  }
}
