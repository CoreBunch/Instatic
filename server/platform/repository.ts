import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import type {
  CreateProjectInput,
  OrganizationRole,
  PlatformOrganization,
  PlatformUser,
  ProjectRole,
  ProjectSourceMode,
  ProjectSummary,
  ProjectWorkspaceState,
} from '@core/platform/schemas'

interface UserRow {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
}

interface OrganizationRow {
  id: string
  name: string
  slug: string
  role: OrganizationRole
}

interface ProjectRow {
  id: string
  organization_id: string
  name: string
  slug: string
  client_name: string | null
  source_mode: ProjectSourceMode
  workspace_state: ProjectWorkspaceState
  role: ProjectRole
  latest_revision: number | string
  updated_at: string | Date
}

function mapUser(row: UserRow): PlatformUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
  }
}

function mapOrganization(row: OrganizationRow): PlatformOrganization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
  }
}

function mapProject(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    clientName: row.client_name,
    sourceMode: row.source_mode,
    workspaceState: row.workspace_state,
    role: row.role,
    latestRevision: Number(row.latest_revision),
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at),
  }
}

export async function upsertPlatformUser(
  db: DbClient,
  user: PlatformUser,
): Promise<PlatformUser> {
  const { rows } = await db<UserRow>`
    insert into platform_users (id, email, name, avatar_url)
    values (${user.id}, ${user.email}, ${user.name}, ${user.avatarUrl})
    on conflict (id) do update
      set email = excluded.email,
          name = excluded.name,
          avatar_url = excluded.avatar_url,
          updated_at = current_timestamp
    returning id, email, name, avatar_url
  `
  const row = rows[0]
  if (!row) throw new Error('Platform user upsert did not return a row')
  return mapUser(row)
}

export async function upsertPlatformOrganization(
  db: DbClient,
  organization: Pick<PlatformOrganization, 'id' | 'name' | 'slug'>,
): Promise<void> {
  await db`
    insert into platform_organizations (id, name, slug)
    values (${organization.id}, ${organization.name}, ${organization.slug})
    on conflict (id) do update
      set name = excluded.name,
          slug = excluded.slug,
          updated_at = current_timestamp
  `
}

export async function upsertOrganizationMembership(
  db: DbClient,
  input: { organizationId: string; userId: string; role: OrganizationRole },
): Promise<void> {
  await db`
    insert into platform_organization_memberships (organization_id, user_id, role)
    values (${input.organizationId}, ${input.userId}, ${input.role})
    on conflict (organization_id, user_id) do update
      set role = case
            when platform_organization_memberships.role = 'owner' then 'owner'
            else excluded.role
          end,
          updated_at = current_timestamp
  `
}

export async function findOrganizationForUser(
  db: DbClient,
  organizationId: string,
  userId: string,
): Promise<PlatformOrganization | null> {
  const { rows } = await db<OrganizationRow>`
    select o.id, o.name, o.slug, m.role
    from platform_organizations o
    join platform_organization_memberships m on m.organization_id = o.id
    where o.id = ${organizationId}
      and m.user_id = ${userId}
  `
  return rows[0] ? mapOrganization(rows[0]) : null
}

export async function countOrganizationMemberships(
  db: DbClient,
  organizationId: string,
): Promise<number> {
  const { rows } = await db<{ count: number | string }>`
    select count(*) as count
    from platform_organization_memberships
    where organization_id = ${organizationId}
  `
  return Number(rows[0]?.count ?? 0)
}

function baseSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return normalized || 'project'
}

export async function uniqueOrganizationSlug(
  db: DbClient,
  name: string,
  excludeId?: string,
): Promise<string> {
  const root = baseSlug(name)
  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const candidate = suffix === 1 ? root : `${root}-${suffix}`
    const { rows } = await db<{ id: string }>`
      select id from platform_organizations
      where slug = ${candidate}
    `
    if (!rows[0] || rows[0].id === excludeId) return candidate
  }
  throw new Error('Unable to allocate an organization slug')
}

async function uniqueProjectSlug(
  db: DbClient,
  organizationId: string,
  name: string,
): Promise<string> {
  const root = baseSlug(name)
  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const candidate = suffix === 1 ? root : `${root}-${suffix}`
    const { rows } = await db<{ id: string }>`
      select id from platform_projects
      where organization_id = ${organizationId}
        and slug = ${candidate}
        and archived_at is null
    `
    if (!rows[0]) return candidate
  }
  throw new Error('Unable to allocate a project slug')
}

export async function listProjectsForUser(
  db: DbClient,
  organization: PlatformOrganization,
  userId: string,
): Promise<ProjectSummary[]> {
  const elevated = organization.role === 'owner' || organization.role === 'admin'
  const { rows } = elevated
    ? await db<ProjectRow>`
        select p.id, p.organization_id, p.name, p.slug, p.client_name,
               p.source_mode, p.workspace_state,
               coalesce(pm.role, 'manager') as role,
               coalesce(max(r.sequence), 1) as latest_revision,
               p.updated_at
        from platform_projects p
        left join platform_project_memberships pm
          on pm.project_id = p.id and pm.user_id = ${userId}
        left join platform_project_revisions r on r.project_id = p.id
        where p.organization_id = ${organization.id}
          and p.archived_at is null
        group by p.id, p.organization_id, p.name, p.slug, p.client_name,
                 p.source_mode, p.workspace_state, pm.role, p.updated_at
        order by p.updated_at desc
      `
    : await db<ProjectRow>`
        select p.id, p.organization_id, p.name, p.slug, p.client_name,
               p.source_mode, p.workspace_state, pm.role,
               coalesce(max(r.sequence), 1) as latest_revision,
               p.updated_at
        from platform_projects p
        join platform_project_memberships pm
          on pm.project_id = p.id and pm.user_id = ${userId}
        left join platform_project_revisions r on r.project_id = p.id
        where p.organization_id = ${organization.id}
          and p.archived_at is null
        group by p.id, p.organization_id, p.name, p.slug, p.client_name,
                 p.source_mode, p.workspace_state, pm.role, p.updated_at
        order by p.updated_at desc
      `
  return rows.map(mapProject)
}

export async function createProject(
  db: DbClient,
  input: CreateProjectInput & { organizationId: string; userId: string },
): Promise<ProjectSummary> {
  const id = `prj_${nanoid(18)}`
  const revisionId = `rev_${nanoid(18)}`
  const slug = await uniqueProjectSlug(db, input.organizationId, input.name)
  const clientName = input.clientName?.trim() || null

  await db.transaction(async (tx) => {
    await tx`
      insert into platform_projects (
        id, organization_id, name, slug, client_name, source_mode,
        workspace_state, created_by_user_id
      )
      values (
        ${id}, ${input.organizationId}, ${input.name.trim()}, ${slug},
        ${clientName}, ${input.sourceMode}, 'unprovisioned', ${input.userId}
      )
    `
    await tx`
      insert into platform_project_memberships (project_id, user_id, role)
      values (${id}, ${input.userId}, 'manager')
    `
    await tx`
      insert into platform_project_revisions (
        id, project_id, sequence, state, source_kind, created_by_user_id
      )
      values (${revisionId}, ${id}, 1, 'created', ${input.sourceMode}, ${input.userId})
    `
    await tx`
      insert into platform_environments (id, project_id, kind)
      values (${`env_${nanoid(18)}`}, ${id}, 'preview')
    `
    await tx`
      insert into platform_environments (id, project_id, kind)
      values (${`env_${nanoid(18)}`}, ${id}, 'production')
    `
  })

  const { rows } = await db<ProjectRow>`
    select p.id, p.organization_id, p.name, p.slug, p.client_name,
           p.source_mode, p.workspace_state, pm.role,
           1 as latest_revision, p.updated_at
    from platform_projects p
    join platform_project_memberships pm
      on pm.project_id = p.id and pm.user_id = ${input.userId}
    where p.id = ${id}
  `
  const row = rows[0]
  if (!row) throw new Error('Created project could not be reloaded')
  return mapProject(row)
}

export async function storeAuthAttempt(
  db: DbClient,
  input: { state: string; codeVerifier: string; expiresAt: string },
): Promise<void> {
  await db`
    delete from platform_auth_attempts
    where expires_at < ${new Date().toISOString()}
  `
  await db`
    insert into platform_auth_attempts (state_hash, code_verifier, expires_at)
    values (${hashState(input.state)}, ${input.codeVerifier}, ${input.expiresAt})
  `
}

export async function consumeAuthAttempt(
  db: DbClient,
  state: string,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const stateHash = hashState(state)
    const { rows } = await tx<{ code_verifier: string; expires_at: string | Date }>`
      select code_verifier, expires_at
      from platform_auth_attempts
      where state_hash = ${stateHash}
    `
    await tx`
      delete from platform_auth_attempts
      where state_hash = ${stateHash}
    `
    const row = rows[0]
    if (!row) return null
    const expiresAt = row.expires_at instanceof Date
      ? row.expires_at
      : new Date(row.expires_at)
    return expiresAt.getTime() > Date.now() ? row.code_verifier : null
  })
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex')
}
