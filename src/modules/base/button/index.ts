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
import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import { AnchorTargetSchema, ANCHOR_TARGET_OPTIONS, anchorRel } from '@modules/base/shared/anchorTarget'
import {
  htmlAttributesAttr,
  htmlAttributesControl,
  HtmlAttributesPropSchemaOptions,
} from '@modules/base/shared/htmlAttributes'
import { resolveButtonAnchor } from './anchor'
import { ButtonEditor } from './ButtonEditor'

const ButtonPropsSchema = Type.Object({
  label: Type.String({ default: 'Get Started' }),
  href: Type.String({ default: '' }),
  target: AnchorTargetSchema,
  disabled: Type.Boolean({ default: false }),
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

export type ButtonStoredProps = Static<typeof ButtonPropsSchema>

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
