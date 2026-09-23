import { Type, type Static } from '@sinclair/typebox'

/** SMTP is performed by the host, never by the plugin VM. */
export const PluginMailSendInputSchema = Type.Object({
  transport: Type.Object({
    host: Type.String({ minLength: 1, maxLength: 253, pattern: '^[a-zA-Z0-9.-]+$' }),
    port: Type.Union([Type.Literal(465), Type.Literal(587)]),
    secure: Type.Boolean(),
    username: Type.String({ minLength: 1, maxLength: 320 }),
    password: Type.String({ minLength: 1, maxLength: 1024 }),
  }, { additionalProperties: false }),
  message: Type.Object({
    from: Type.String({ minLength: 1, maxLength: 320, pattern: '^[^\\r\\n]+$' }),
    to: Type.String({ minLength: 1, maxLength: 320, pattern: '^[^\\r\\n]+$' }),
    subject: Type.String({ minLength: 1, maxLength: 500, pattern: '^[^\\r\\n]+$' }),
    text: Type.String({ minLength: 1, maxLength: 65_536 }),
    html: Type.Optional(Type.String({ maxLength: 65_536 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false })

export type PluginMailSendInput = Static<typeof PluginMailSendInputSchema>
