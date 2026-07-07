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
  htmlAttributesForReact,
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
  },

  propsSchema: ContainerPropsSchema,

  defaults: Value.Create(ContainerPropsSchema),

  component: ContainerEditor,

  htmlTag: (props) => resolveHtmlTag(props.tag, props.customTag),

  htmlContract: {
    tag: (props) => resolveHtmlTag(props.tag, props.customTag),
    attributes: (props) => htmlAttributesForReact(props.htmlAttributes),
    canHaveChildren: true,
    claimSelector: 'div, section, article, main, header, footer, nav, aside, ul, ol',
    fromHtml: (el) => {
      const tag = el.tagName.toLowerCase()
      const builtinTags = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'ul', 'ol'])
      if (builtinTags.has(tag)) {
        return { tag, customTag: '' }
      }
      return { tag: 'custom', customTag: tag }
    },
  },

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
