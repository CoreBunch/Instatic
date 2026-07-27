/**
 * base.container — semantic wrapper.
 *
 * Emits the chosen semantic tag with no default class or default CSS.
 * Visual styling is opt-in via user classes (mcClassName / multi-class system).
 *
 * Tag selection is shared with `base.loop` via `@modules/base/utils/htmlTag`:
 * built-in layout/list tags plus a 'custom' escape hatch (free-form `customTag`
 * text input) so authors can render any valid HTML element name.
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import {
  customHtmlTagControl,
  htmlTagControl,
  resolveHtmlTag,
  VOID_HTML_ELEMENTS,
} from '@modules/base/utils/htmlTag'
import {
  htmlAttributesAttr,
  htmlAttributesControl,
} from '@modules/base/shared/htmlAttributes'
import { Value } from '@core/utils/typeboxHelpers'
import { ContainerEditor } from './ContainerEditor'
import { ContainerPropsSchema, type ContainerStoredProps } from './props'

export const ContainerModule: ModuleDefinition<ContainerStoredProps> = {
  id: 'base.container',
  name: 'Container',
  description: 'A semantic container.',
  category: 'Layout',
  version: '2.0.0',
  icon: SquareSolidIcon,
  trusted: true,
  canHaveChildren: true,

  schema: {
    tag: htmlTagControl(),
    customTag: customHtmlTagControl(),
    htmlAttributes: htmlAttributesControl(),
    authGate: {
      // TRANSITIONAL (Wave 4 owns the UI): the gate is now a list of group ids
      // (D16), not the Phase-2 member/admin select. Until the Wave-4 group
      // picker lands this is a free-form text control accepting comma-
      // separated group ids. The prop schema (props.ts) is the source of
      // truth — it is `string[]`; this control only describes the editor UI.
      type: 'text',
      label: 'Auth gate (group ids, comma-separated)',
      placeholder: 'group-id-1, group-id-2',
    },
  },

  propsSchema: ContainerPropsSchema,

  defaults: Value.Create(ContainerPropsSchema),

  component: ContainerEditor,

  htmlTag: (props) => resolveHtmlTag(props.tag, props.customTag),

  render: (props, renderedChildren) => {
    const tag = resolveHtmlTag(props.tag, props.customTag)
    const attrs = htmlAttributesAttr(props.htmlAttributes)
    // Void elements (br, hr, img, …) take no closing tag — `<br></br>` would
    // be parsed as two <br>s.
    if (VOID_HTML_ELEMENTS.has(tag.toLowerCase())) {
      return { html: `<${tag}${attrs}>` }
    }
    return {
      html: `<${tag}${attrs}>${renderedChildren.join('')}</${tag}>`,
    }
  },
}

registry.registerOrReplace(ContainerModule)
