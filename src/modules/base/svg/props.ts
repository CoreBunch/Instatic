import { Type, type Static } from '@core/utils/typeboxHelpers'
import { HtmlAttributesPropSchemaOptions } from '@modules/base/shared/htmlAttributes'

export const SvgPropsSchema = Type.Object({
  svg: Type.String({ default: '' }),
  title: Type.String({ default: '' }),
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

export type SvgStoredProps = Static<typeof SvgPropsSchema>
