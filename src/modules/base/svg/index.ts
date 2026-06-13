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
import { escapeHtml } from '@core/publisher'
import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import { SvgEditor } from './SvgEditor'

const SvgPropsSchema = Type.Object({
  /** Raw inline SVG markup (e.g. `<svg viewBox="0 0 24 24">…</svg>`). */
  svg: Type.String({ default: '' }),
  /** Accessible label; when set, emitted as `role="img" aria-label`. */
  title: Type.String({ default: '' }),
})

export type SvgStoredProps = Static<typeof SvgPropsSchema>

const SvgModule: ModuleDefinition<SvgStoredProps> = {
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
  },

  propsSchema: SvgPropsSchema,

  defaults: Value.Create(SvgPropsSchema),

  component: SvgEditor,

  htmlTag: 'svg',

  render: (props) => {
    // `props.svg` was already sanitised at the escapeProps boundary; this is
    // the final, safe markup. An a11y label, when present, is added to the
    // root element so the inline graphic announces itself.
    const markup = String(props.svg ?? '')
    if (!markup.trim()) return { html: '' }

    const label = String(props.title ?? '').trim()
    if (label) {
      // Inject role/aria-label onto the opening <svg> tag.
      const withLabel = markup.replace(
        /^(\s*<svg\b)/i,
        `$1 role="img" aria-label="${escapeHtml(label)}"`,
      )
      return { html: withLabel }
    }
    return { html: markup }
  },
}

registry.registerOrReplace(SvgModule)
