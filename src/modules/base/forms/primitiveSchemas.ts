import { Type, type Static } from '@sinclair/typebox'
import { FormControlBehaviorProperties, FormConfigurationProperties } from '@core/forms-schema'
import { HtmlAttributesPropSchemaOptions } from '@modules/base/shared/htmlAttributes'

export const FormPropsSchema = Type.Object({
  ...FormConfigurationProperties,
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

export type FormProps = Static<typeof FormPropsSchema>

export const LabelPropsSchema = Type.Object({
  text: Type.String({ default: 'Label' }),
  targetMode: Type.Union([Type.Literal('auto'), Type.Literal('explicit')], { default: 'auto' }),
  targetId: Type.String({ default: '' }),
})

export type LabelProps = Static<typeof LabelPropsSchema>

export const InputPropsSchema = Type.Object({
  ...FormControlBehaviorProperties,
  inputType: Type.Union([
    Type.Literal('text'),
    Type.Literal('email'),
    Type.Literal('password'),
    Type.Literal('search'),
    Type.Literal('tel'),
    Type.Literal('url'),
    Type.Literal('number'),
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
  minLength: Type.Number({ default: 0 }),
  maxLength: Type.Number({ default: 0 }),
  pattern: Type.String({ default: '' }),
})

export type InputProps = Static<typeof InputPropsSchema>

export const TextareaPropsSchema = Type.Object({
  ...FormControlBehaviorProperties,
  fieldId: Type.String({ default: '' }),
  name: Type.String({ default: '' }),
  id: Type.String({ default: '' }),
  placeholder: Type.String({ default: '' }),
  value: Type.String({ default: '' }),
  required: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
  readOnly: Type.Boolean({ default: false }),
  rows: Type.Number({ default: 4 }),
  minLength: Type.Number({ default: 0 }),
  maxLength: Type.Number({ default: 0 }),
})

export type TextareaProps = Static<typeof TextareaPropsSchema>

export const SelectPropsSchema = Type.Object({
  ...FormControlBehaviorProperties,
  fieldId: Type.String({ default: '' }),
  name: Type.String({ default: '' }),
  id: Type.String({ default: '' }),
  required: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
  multiple: Type.Boolean({ default: false }),
})

export type SelectProps = Static<typeof SelectPropsSchema>

export const OptionPropsSchema = Type.Object({
  value: Type.String({ default: '' }),
  label: Type.String({ default: 'Option' }),
  selected: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
})

export type OptionProps = Static<typeof OptionPropsSchema>

export const OptionGroupPropsSchema = Type.Object({
  label: Type.String({ default: 'Group' }),
  disabled: Type.Boolean({ default: false }),
})

export type OptionGroupProps = Static<typeof OptionGroupPropsSchema>

export const ChoicePropsSchema = Type.Object({
  ...FormControlBehaviorProperties,
  fieldId: Type.String({ default: '' }),
  name: Type.String({ default: '' }),
  id: Type.String({ default: '' }),
  value: Type.String({ default: 'on' }),
  checked: Type.Boolean({ default: false }),
  required: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
})

export type ChoiceProps = Static<typeof ChoicePropsSchema>

export const SubmitPropsSchema = Type.Object({
  label: Type.String({ default: 'Submit' }),
  disabled: Type.Boolean({ default: false }),
  formId: Type.String({ default: '' }),
})

export type SubmitProps = Static<typeof SubmitPropsSchema>

export const FormMessagePropsSchema = Type.Object({
  formId: Type.String({ default: '' }),
  source: Type.Union([Type.Literal('state'), Type.Literal('authored'), Type.Literal('response')], { default: 'state' }),
  kind: Type.Union([Type.Literal('status'), Type.Literal('success'), Type.Literal('error')], { default: 'status' }),
  text: Type.String({ default: '' }),
})

export type FormMessageProps = Static<typeof FormMessagePropsSchema>
