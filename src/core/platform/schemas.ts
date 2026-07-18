import { Type, type Static } from '@sinclair/typebox'

export const PlatformAuthModeSchema = Type.Union([
  Type.Literal('development'),
  Type.Literal('workos'),
])

export const OrganizationRoleSchema = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
  Type.Literal('guest'),
])

export const ProjectRoleSchema = Type.Union([
  Type.Literal('manager'),
  Type.Literal('designer'),
  Type.Literal('developer'),
  Type.Literal('content_editor'),
  Type.Literal('reviewer'),
  Type.Literal('publisher'),
])

export const ProjectSourceModeSchema = Type.Union([
  Type.Literal('instatic'),
  Type.Literal('github'),
  Type.Literal('local_bridge'),
  Type.Literal('github_bridge'),
])

export const ProjectWorkspaceStateSchema = Type.Union([
  Type.Literal('unprovisioned'),
  Type.Literal('provisioning'),
  Type.Literal('ready'),
  Type.Literal('error'),
])

export const PlatformUserSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 3 }),
  name: Type.Union([Type.String(), Type.Null()]),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
})

export const PlatformOrganizationSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  role: OrganizationRoleSchema,
})

export const PlatformSessionSchema = Type.Object({
  authMode: PlatformAuthModeSchema,
  user: PlatformUserSchema,
  organization: Type.Union([PlatformOrganizationSchema, Type.Null()]),
})

export const PlatformSessionEnvelopeSchema = Type.Object({
  session: PlatformSessionSchema,
})

export const ProjectSummarySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  organizationId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  clientName: Type.Union([Type.String(), Type.Null()]),
  sourceMode: ProjectSourceModeSchema,
  workspaceState: ProjectWorkspaceStateSchema,
  role: ProjectRoleSchema,
  latestRevision: Type.Integer({ minimum: 1 }),
  updatedAt: Type.String({ minLength: 1 }),
})

export const ProjectListEnvelopeSchema = Type.Object({
  projects: Type.Array(ProjectSummarySchema),
})

export const CreateProjectInputSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  clientName: Type.Optional(Type.Union([
    Type.String({ maxLength: 120 }),
    Type.Null(),
  ])),
  sourceMode: ProjectSourceModeSchema,
})

export const ProjectEnvelopeSchema = Type.Object({
  project: ProjectSummarySchema,
})

export const CreateOrganizationInputSchema = Type.Object({
  name: Type.String({ minLength: 2, maxLength: 120 }),
})

export type PlatformAuthMode = Static<typeof PlatformAuthModeSchema>
export type OrganizationRole = Static<typeof OrganizationRoleSchema>
export type ProjectRole = Static<typeof ProjectRoleSchema>
export type ProjectSourceMode = Static<typeof ProjectSourceModeSchema>
export type ProjectWorkspaceState = Static<typeof ProjectWorkspaceStateSchema>
export type PlatformUser = Static<typeof PlatformUserSchema>
export type PlatformOrganization = Static<typeof PlatformOrganizationSchema>
export type PlatformSession = Static<typeof PlatformSessionSchema>
export type ProjectSummary = Static<typeof ProjectSummarySchema>
export type CreateProjectInput = Static<typeof CreateProjectInputSchema>
