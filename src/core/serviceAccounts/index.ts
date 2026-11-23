import { Type, type Static } from '../utils/typeboxHelpers'
import { DELEGABLE_CAPABILITIES } from '../capabilities'

export const ServiceCapabilitySchema = Type.Union(DELEGABLE_CAPABILITIES.map(c => Type.Literal(c)))
export const ServiceAccountInputSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 100 }),
  capabilities: Type.Array(ServiceCapabilitySchema, { minItems: 1, uniqueItems: true }),
  ttlHours: Type.Integer({ minimum: 1, maximum: 720 }),
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
