/**
 * base.button — content/behavior module.
 *
 * Emits a bare semantic `<button>` (or `<a>` when `href` is set) with no
 * default class or default CSS. Visual styling is opt-in via user classes
 * (mcClassName / multi-class system).
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { CursorClickSolidIcon } from 'pixel-art-icons/icons/cursor-click-solid'
import { Value } from '@core/utils/typeboxHelpers'
import { ANCHOR_TARGET_OPTIONS, anchorRel } from '@modules/base/shared/anchorTarget'
import {
  htmlAttributesAttr,
  htmlAttributesControl,
  htmlAttributesForReact,
} from '@modules/base/shared/htmlAttributes'
import { normalizeImportedText } from '@core/htmlImport'
import { resolveButtonAnchor } from './anchor'
import { ButtonEditor } from './ButtonEditor'
import { ButtonPropsSchema, type ButtonStoredProps } from './props'

export const ButtonModule: ModuleDefinition<ButtonStoredProps> = {
  id: 'base.button',
  name: 'Button',
  description: 'A button or call-to-action link.',
  category: 'Interactive',
  version: '2.0.0',
  icon: CursorClickSolidIcon,
  trusted: true,
  canHaveChildren: false,
  inlineTextEdit: { prop: 'label' },

  schema: {
    label: { type: 'text', label: 'Label', placeholder: 'Button text...' },
    href: { type: 'url', label: 'Link URL' },
    target: {
      type: 'select',
      label: 'Link target',
      // Choosing how a button opens its link is a content decision, not a
      // structural one — exposed to the Client role.
      category: 'content',
      condition: { field: 'href', notEq: '' },
      options: [...ANCHOR_TARGET_OPTIONS],
    },
    disabled: { type: 'toggle', label: 'Disabled' },
    htmlAttributes: htmlAttributesControl(),
  },

  propsSchema: ButtonPropsSchema,

  defaults: Value.Create(ButtonPropsSchema),

  component: ButtonEditor,

  htmlTag: (props) => (resolveButtonAnchor(props.href) ? 'a' : 'button'),

  htmlContract: {
    tag: (props) => (resolveButtonAnchor(props.href) ? 'a' : 'button'),
    attributes: (props) => {
      const attrs = htmlAttributesForReact(props.htmlAttributes)
      const anchor = resolveButtonAnchor(props.href)
      if (anchor) {
        attrs['href'] = anchor.href
        attrs['target'] = String(props.target)
        const rel = anchorRel(props.target)
        if (rel) attrs['rel'] = rel
      } else {
        attrs['type'] = 'button'
        if (props.disabled) {
          attrs['disabled'] = ''
          attrs['aria-disabled'] = 'true'
        }
      }
      return attrs
    },
    textContent: (props) => String(props.label ?? ''),
    claimSelector: 'button:not([type="submit"]), a.btn, .btn, [data-module="button"]',
    canHaveChildren: false,
    fromHtml: (el) => {
      const tag = el.tagName.toLowerCase()
      if (tag === 'a') {
        const target = el.getAttribute('target') ?? '_self'
        return {
          label: normalizeImportedText(el.textContent ?? ''),
          href: el.getAttribute('href') ?? '',
          target: (['_self', '_blank', '_parent'].includes(target) ? target : '_self') as ButtonStoredProps['target'],
          disabled: false,
        }
      }
      return {
        label: normalizeImportedText(el.textContent ?? ''),
        href: '',
        disabled: el.hasAttribute('disabled'),
      }
    },
  },

  render: (props) => {
    const label = String(props.label ?? '')
    const attrs = htmlAttributesAttr(props.htmlAttributes)
    const anchor = resolveButtonAnchor(props.href)
    if (anchor) {
      const rel = anchorRel(props.target)
      const relAttr = rel ? ` rel="${rel}"` : ''
      return { html: `<a${attrs} href="${anchor.href}" target="${String(props.target)}"${relAttr}>${label}</a>` }
    }
    const disabledAttr = props.disabled ? ' disabled aria-disabled="true"' : ''
    return { html: `<button${attrs} type="button"${disabledAttr}>${label}</button>` }
  },
}

registry.registerOrReplace(ButtonModule)
