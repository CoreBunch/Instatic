import { Type, type Static } from '@core/utils/typeboxHelpers'

const FormControlBindingSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  fieldId: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  inputType: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  minLength: Type.Optional(Type.Number()),
  maxLength: Type.Optional(Type.Number()),
  pattern: Type.Optional(Type.String()),
})

export type FormControlBinding = Static<typeof FormControlBindingSchema>

const FormSubmissionLimitsSchema = Type.Object({
  maxFields: Type.Optional(Type.Number()),
  maxStringLength: Type.Optional(Type.Number()),
})

export type FormSubmissionLimits = Static<typeof FormSubmissionLimitsSchema>

const FormValidationErrorSchema = Type.Object({
  fieldId: Type.String(),
  code: Type.String(),
  message: Type.String(),
})

export type FormValidationError = Static<typeof FormValidationErrorSchema>

export const PublicFormSubmitBodySchema = Type.Object({
  formId: Type.String({ minLength: 1 }),
  pageId: Type.String({ minLength: 1 }),
  token: Type.String({ minLength: 1 }),
  challenge: Type.String({ minLength: 1 }),
  values: Type.Record(Type.String(), Type.Unknown()),
})

export const PublicFormChallengeBodySchema = Type.Object({
  formId: Type.String({ minLength: 1 }),
  pageId: Type.String({ minLength: 1 }),
  pageToken: Type.String({ minLength: 1 }),
})

const PublishedFormLabelSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  targetNodeId: Type.String({ minLength: 1 }),
  text: Type.String(),
})

export type PublishedFormLabel = Static<typeof PublishedFormLabelSchema>

const PublishedFormSubmitSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  label: Type.String(),
})

export type PublishedFormSubmit = Static<typeof PublishedFormSubmitSchema>

const PublishedFormMessageSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal('status'), Type.Literal('success'), Type.Literal('error')]),
  text: Type.String(),
})

export type PublishedFormMessage = Static<typeof PublishedFormMessageSchema>

const PublishedFormSnapshotSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  nodeId: Type.String({ minLength: 1 }),
  formId: Type.String({ minLength: 1 }),
  targetTableId: Type.String(),
  honeypotName: Type.String(),
  minSubmitSeconds: Type.Number(),
  controls: Type.Array(FormControlBindingSchema),
  labels: Type.Array(PublishedFormLabelSchema),
  submits: Type.Array(PublishedFormSubmitSchema),
  messages: Type.Array(PublishedFormMessageSchema),
})

export type PublishedFormSnapshot = Static<typeof PublishedFormSnapshotSchema>
