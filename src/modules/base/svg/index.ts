/**
 * base.svg — inline SVG module.
 *
 * Stores a raw inline-SVG markup string (`svg`) and emits it verbatim, after
 * the publisher boundary sanitises it via the DOMPurify SVG profile
 * (`escapeProps` → `sanitizeSvg`). Inline (vs. an `<img src>`) so the SVG can
 * inherit `currentColor` and be styled by user CSS classes — the way logos and
 * icons are authored in real sites.
 *
 * The `svg` prop key is recognised by `escapeProps` as an SVG boundary, so it
 * is neither HTML-escaped (which would print `&lt;svg&gt;`) nor richtext-
 * stripped (which would remove every SVG tag).
 */
import { registry } from '@core/module-engine'
import type { ModuleDefinition } from '@core/module-engine'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { Value } from '@core/utils/typeboxHelpers'
import { htmlAttributesAttr } from '@core/publisher'
import { htmlAttributesControl } from '@modules/base/shared/htmlAttributes'
import { SvgEditor } from './SvgEditor'
import { SvgPropsSchema, type SvgStoredProps } from './props'

export const SvgModule: ModuleDefinition<SvgStoredProps> = {
  id: 'base.svg',
  name: 'SVG',
  description: 'Inline vector graphic (logo or icon).',
  category: 'Media',
  version: '1.0.0',
  icon: ImageSolidIcon,
  trusted: true,
  canHaveChildren: false,

  schema: {
    svg: {
      type: 'svg',
      label: 'SVG',
      category: 'content',
    },
    title: {
      type: 'text',
      label: 'Accessible label',
      category: 'content',
      placeholder: 'e.g. Company logo',
    },
    htmlAttributes: htmlAttributesControl(),
  },

  propsSchema: SvgPropsSchema,

  defaults: Value.Create(SvgPropsSchema),

  component: SvgEditor,

  htmlTag: 'svg',

  render: (props) => {
    // `props.svg` was already sanitised at the escapeProps boundary; this is
    // the final, safe markup. An a11y label, when present, and the authored
    // HTML attributes are added to the root element. They go first so they
    // win over same-named attributes already on the markup's root.
    const markup = String(props.svg ?? '')
    if (!markup.trim()) return { html: '' }

    const label = String(props.title ?? '').trim()
    const labelAttrs = label ? ` role="img" aria-label="${label}"` : ''
    const rootAttrs = `${labelAttrs}${htmlAttributesAttr(props.htmlAttributes)}`
    if (!rootAttrs) return { html: markup }
    return { html: markup.replace(/^(\s*<svg\b)/i, `$1${rootAttrs}`) }
  },
}

registry.registerOrReplace(SvgModule)
