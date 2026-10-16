import { Type, type Static } from '@core/utils/typeboxHelpers'

export const InputPropsSchema = Type.Object({
  inputType: Type.Union([
    Type.Literal('text'),
    Type.Literal('email'),
    Type.Literal('password'),
    Type.Literal('search'),
    Type.Literal('tel'),
    Type.Literal('url'),
    Type.Literal('number'),
    Type.Literal('range'),
    Type.Literal('date'),
    Type.Literal('time'),
    Type.Literal('datetime-local'),
    Type.Literal('file'),
    Type.Literal('hidden'),
  ], { default: 'text' }),
  fieldId: Type.String({ default: '' }),
  name: Type.String({ default: '' }),
  id: Type.String({ default: '' }),
  placeholder: Type.String({ default: '' }),
  value: Type.String({ default: '' }),
  required: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
  readOnly: Type.Boolean({ default: false }),
  autocomplete: Type.String({ default: '' }),
  min: Type.String({ default: '' }),
  max: Type.String({ default: '' }),
  step: Type.String({ default: '' }),
  minLength: Type.Number({ default: 0 }),
  maxLength: Type.Number({ default: 0 }),
  pattern: Type.String({ default: '' }),
})

export type InputProps = Static<typeof InputPropsSchema>
