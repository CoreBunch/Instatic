import { Type, type Static } from '../utils/typeboxHelpers'
import { DELEGABLE_CAPABILITIES } from '../capabilities'

export const ServiceCapabilitySchema = Type.Union(DELEGABLE_CAPABILITIES.map(c => Type.Literal(c)))
const ttlHours = Type.Integer({ minimum: 1, maximum: 720 })
export const RenewServiceAccountSchema = Type.Object({ ttlHours }, { additionalProperties: false })
export const ServiceRenewalReceiptSchema = Type.Object({ expiresAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }) })
export const ServiceAccountInputSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 100 }),
  capabilities: Type.Array(ServiceCapabilitySchema, { minItems: 1, uniqueItems: true }),
  ttlHours,
}, { additionalProperties: false })
export const ServiceAccountSchema = Type.Object({
  id: Type.String(), label: Type.String(), capabilities: Type.Array(ServiceCapabilitySchema),
  expiresAt: Type.String(), connected: Type.Boolean(), revoked: Type.Boolean(), expired: Type.Boolean(),
})
export type ServiceAccount = Static<typeof ServiceAccountSchema>
export const ServiceOverviewSchema = Type.Object({
  accounts: Type.Array(ServiceAccountSchema), cliFilename: Type.String(), origin: Type.Union([Type.String(), Type.Null()]),
})
const challenge = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })
export const ApproveServiceSchema = Type.Object({ challenge })
export const ExchangeServiceSchema = Type.Object({
  code: Type.String({ minLength: 43, maxLength: 90 }), verifier: Type.String({ pattern: '^[A-Za-z0-9._~-]{43,128}$' }),
})
export const ServiceCodeSchema = Type.Object({ code: Type.String() })

export const ServiceActivitySchema = Type.Object({
  events: Type.Array(Type.Object({
    id: Type.String(), title: Type.String(), agent: Type.String(), at: Type.String(),
    expiresAt: Type.Optional(ServiceRenewalReceiptSchema.properties.expiresAt),
    scope: Type.Union([Type.String(), Type.Null()]), status: Type.Union([Type.Integer(), Type.Null()]),
  })),
})
export type ServiceActivity = Static<typeof ServiceActivitySchema>['events'][number]
