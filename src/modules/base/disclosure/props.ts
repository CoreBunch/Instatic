import { Type, type Static } from '@core/utils/typeboxHelpers'
import { HtmlAttributesPropSchemaOptions } from '@modules/base/shared/htmlAttributes'

export const DisclosurePropsSchema = Type.Object({
  group: Type.String({ default: '' }),
  initiallyOpen: Type.Boolean({ default: false }),
  closeOnEscape: Type.Boolean({ default: true }),
  closeOnOutsidePointer: Type.Boolean({ default: false }),
  closeOnFocusLeave: Type.Boolean({ default: false }),
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

export type DisclosureStoredProps = Static<typeof DisclosurePropsSchema>
