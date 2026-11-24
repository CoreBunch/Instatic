import type { CoreCapability } from '../capabilities'
import { BRANCH_ID_PATTERN } from '../branches'
import { Type, nullable, type Static } from '../utils/typeboxHelpers'
import { ApproveServiceSchema, ExchangeServiceSchema, ServiceAccountInputSchema } from './accounts'

export const GROUP_CAPABILITIES = [
  'site.read', 'site.content.edit', 'site.structure.edit', 'site.style.edit',
  'data.custom.tables.read', 'data.system.tables.read',
] as const satisfies readonly CoreCapability[]

const groupCapability = Type.Union(GROUP_CAPABILITIES.map(capability => Type.Literal(capability)))
const label = Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' })
const member = Type.Object({
  label,
  responsibility: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }),
  capabilities: Type.Array(groupCapability, { minItems: 1, uniqueItems: true }),
}, { additionalProperties: false })
export const ServiceGroupInputSchema = Type.Object({
  label,
  members: Type.Array(member, { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false })
export const ServiceGroupSchema = Type.Object({ ...ServiceGroupInputSchema.properties, id: Type.String() })
export type ServiceGroup = Static<typeof ServiceGroupSchema>

export const ServiceGroupRunInputSchema = Type.Object({
  branchId: Type.String({ pattern: BRANCH_ID_PATTERN.source }),
  task: Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S' }),
  ttlHours: ServiceAccountInputSchema.properties.ttlHours,
}, { additionalProperties: false })
const accountId = Type.String({ pattern: '^svc_[a-f0-9-]{36}$' })
const challenge = ApproveServiceSchema.properties.challenge
const runMember = Type.Object({
  ...member.properties, accountId, challenge: nullable(challenge), connected: Type.Boolean(),
})
export const ServiceGroupRunSchema = Type.Object({
  id: Type.String(), groupId: Type.String(), branchId: nullable(Type.String()), task: Type.String(),
  expiresAt: Type.String(), approved: Type.Boolean(), expired: Type.Boolean(), revoked: Type.Boolean(), members: Type.Array(runMember),
})
export type ServiceGroupRun = Static<typeof ServiceGroupRunSchema>
export const ServiceGroupOverviewSchema = Type.Object({
  groups: Type.Array(ServiceGroupSchema), runs: Type.Array(ServiceGroupRunSchema),
})
const enrollmentKey = Type.String({ pattern: '^icli_enroll_[A-Za-z0-9_-]{43}$' })
export const ServiceGroupRunCreatedSchema = Type.Object({
  run: ServiceGroupRunSchema, invites: Type.Array(Type.Object({ accountId, enrollmentKey })),
})
export const ServiceGroupApproveSchema = Type.Object({
  members: Type.Array(Type.Object({ accountId, challenge }), { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false })
export const ServiceGroupEnrollSchema = Type.Object({
  runId: Type.String({ pattern: '^run_[a-f0-9-]{36}$' }), enrollmentKey, challenge,
}, { additionalProperties: false })
export const ServiceGroupPollSchema = Type.Object({ verifier: ExchangeServiceSchema.properties.verifier }, { additionalProperties: false })
