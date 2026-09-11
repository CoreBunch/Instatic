/**
 * base.outlet — the single content outlet for templates.
 *
 * Polymorphic: the composer either splices matched content (a page tree or a
 * nested template) in place of this node, OR — for the innermost outlet on an
 * entry route — leaves it here to render the current entry's body. The
 * `data-instatic-content-region` marker is what the Content workspace's Live
 * mode mounts Tiptap against, so it is emitted unconditionally.
 *
 * The outlet renders as an author-chosen semantic element (default `<main>`),
 * sharing the tag-selection helpers with `base.container` / `base.loop`. The
 * `html` prop is NOT author-editable — it is the binding target the publisher
 * fills with the current entry's body (`{currentEntry.body}`). It is declared as
 * a `hidden` richtext control: typed so `escapeProps` sanitises it, but rendered
 * with no panel control.
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { Value } from '@core/utils/typeboxHelpers'
import { TargetSolidIcon } from 'pixel-art-icons/icons/target-solid'
import { resolveHtmlTag } from '@core/htmlAttributes'
import { customHtmlTagControl, htmlTagControl } from '@modules/base/utils/htmlTag'
import { OutletEditor } from './OutletEditor'
import { OutletPropsSchema, type OutletStoredProps } from './props'

export const OutletModule: ModuleDefinition<OutletStoredProps> = {
  id: 'base.outlet',
  name: 'Content Outlet',
  description: 'Where matched content (a page or the current entry body) flows in.',
  category: 'CMS',
  version: '1.0.0',
  icon: TargetSolidIcon,
  trusted: true,
  canHaveChildren: false,

  schema: {
    tag: htmlTagControl(),
    customTag: customHtmlTagControl(),
    /**
     * Binding target only — the publisher fills this with the current entry's
     * richtext body (`{currentEntry.body}`) or a bound VC param. Declared as a
     * hidden richtext control so the publisher's `escapeProps` sanitises it via
     * DOMPurify (rather than HTML-escaping it, which would entity-encode the
     * rendered body). `hidden: true` keeps it out of the Properties panel — it
     * is never hand-edited.
     */
    html: { type: 'richtext', label: 'Content', hidden: true },
  },

  propsSchema: OutletPropsSchema,
  defaults: Value.Create(OutletPropsSchema),

  component: OutletEditor,

  htmlTag: (props) => resolveHtmlTag(props.tag, props.customTag),

  render: (props) => {
    const tag = resolveHtmlTag(props.tag, props.customTag)
    const html = typeof props.html === 'string' ? props.html : ''
    return { html: `<${tag} data-instatic-content-region>${html}</${tag}>` }
  },
}

registry.registerOrReplace(OutletModule)
