/**
 * base.link — anchor element.
 *
 * Emits a bare `<a>` with no default class or default CSS.
 * Visual styling is opt-in via user classes (mcClassName / multi-class system).
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { safeUrl } from '@modules/base/utils/escape'
import { Value } from '@core/utils/typeboxHelpers'
import { ANCHOR_TARGET_OPTIONS, anchorRel } from '@modules/base/shared/anchorTarget'
import {
  htmlAttributesAttr,
  htmlAttributesControl,
  htmlAttributesForReact,
} from '@modules/base/shared/htmlAttributes'
import { normalizeImportedText } from '@core/htmlImport'
import { linkUsesChildren } from './content'
import { LinkEditor } from './LinkEditor'
import { LinkPropsSchema, type LinkStoredProps } from './props'

export const LinkModule: ModuleDefinition<LinkStoredProps> = {
  id: 'base.link',
  name: 'Link',
  description: 'An anchor element.',
  category: 'Interactive',
  version: '2.0.0',
  icon: LinkIcon,
  trusted: true,
  canHaveChildren: true,
  // Inline-editable only while childless — the canvas's generic
  // children-guard mirrors linkUsesChildren() in render().
  inlineTextEdit: { prop: 'text' },

  schema: {
    href: { type: 'url', label: 'URL' },
    text: { type: 'text', label: 'Link text', placeholder: 'Displayed when no children' },
    target: {
      type: 'select',
      label: 'Target',
      options: [...ANCHOR_TARGET_OPTIONS],
    },
    htmlAttributes: htmlAttributesControl(),
  },

  propsSchema: LinkPropsSchema,

  defaults: Value.Create(LinkPropsSchema),

  component: LinkEditor,

  htmlTag: 'a',

  htmlContract: {
    tag: 'a',
    attributes: (props) => {
      const attrs = htmlAttributesForReact(props.htmlAttributes)
      attrs['href'] = safeUrl(props.href) || '#'
      attrs['target'] = String(props.target)
      const rel = anchorRel(props.target)
      if (rel) attrs['rel'] = rel
      return attrs
    },
    textContent: (props) => String(props.text ?? ''),
    canHaveChildren: true,
    claimSelector: 'a[href]',
    fromHtml: (el) => {
      const target = el.getAttribute('target') ?? '_self'
      return {
        href: el.getAttribute('href') ?? '#',
        text: normalizeImportedText(el.textContent ?? ''),
        target: (['_self', '_blank', '_parent'].includes(target) ? target : '_self') as LinkStoredProps['target'],
      }
    },
  },

  render: (props, renderedChildren) => {
    const href = safeUrl(props.href)
    const attrs = htmlAttributesAttr(props.htmlAttributes)
    const rel = anchorRel(props.target)
    const relAttr = rel ? ` rel="${rel}"` : ''
    const targetAttr = ` target="${String(props.target)}"`
    const content = linkUsesChildren(renderedChildren.length)
      ? renderedChildren.join('')
      : String(props.text ?? '')
    return {
      html: `<a${attrs} href="${href}"${targetAttr}${relAttr}>${content}</a>`,
    }
  },
}

registry.registerOrReplace(LinkModule)
