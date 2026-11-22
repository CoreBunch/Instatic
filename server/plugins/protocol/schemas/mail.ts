/**
 * TypeBox schemas for the `cms.mail.*` api-call arguments: sending one of the
 * plugin's own templates to a site member or to an address.
 */
import { Type } from '@sinclair/typebox'
import { MAIL_ADDRESS_PATTERN } from '@core/mail'

const TemplateKeySchema = Type.String({ minLength: 1, maxLength: 60 })
/** Values are single strings; the template decides where each goes. */
const VariablesSchema = Type.Record(Type.String({ maxLength: 60 }), Type.String({ maxLength: 4000 }))
const ReferenceSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 200 }))

export const MailSendArgsSchema = Type.Tuple([
  Type.Object(
    {
      template: TemplateKeySchema,
      member: Type.String({ minLength: 1, maxLength: 64 }),
      variables: VariablesSchema,
      reference: ReferenceSchema,
    },
    { additionalProperties: false },
  ),
])

export const MailSendExternalArgsSchema = Type.Tuple([
  Type.Object(
    {
      template: TemplateKeySchema,
      address: Type.String({ minLength: 3, maxLength: 320, pattern: MAIL_ADDRESS_PATTERN }),
      variables: VariablesSchema,
      reference: ReferenceSchema,
    },
    { additionalProperties: false },
  ),
])
