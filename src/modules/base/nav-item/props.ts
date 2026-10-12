import { Type, type Static } from '@core/utils/typeboxHelpers'
import { AnchorTargetSchema } from '@modules/base/shared/anchorTarget'
import { HtmlAttributesPropSchemaOptions } from '@modules/base/shared/htmlAttributes'

export const NavItemPropsSchema = Type.Object({
  label: Type.String({ default: 'Menu item' }),
  /** Off: the label opens this item's submenu instead of following `href`. */
  isLink: Type.Boolean({ default: true }),
  href: Type.String({ default: '#' }),
  target: AnchorTargetSchema,
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

export type NavItemStoredProps = Static<typeof NavItemPropsSchema>
