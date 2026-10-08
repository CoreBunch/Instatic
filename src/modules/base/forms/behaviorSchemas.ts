import { Type } from '@sinclair/typebox'
import { OptionalFormConditionSchema } from '@core/forms-schema'

export const ConditionalPropsSchema = Type.Object({ condition: OptionalFormConditionSchema })
export const OutputPropsSchema = Type.Object({ fieldName: Type.String({ default: '' }), text: Type.String({ default: '' }) })
