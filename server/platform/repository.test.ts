import { beforeEach, describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../db/sqlite'
import { runMigrations } from '../db/runMigrations'
import type { DbClient } from '../db/client'
import type { PlatformOrganization, PlatformUser } from '@core/platform/schemas'
import { platformPgMigrations } from './db/migrations-pg'
import { platformSqliteMigrations } from './db/migrations-sqlite'
import {
  consumeAuthAttempt,
  createProject,
  listProjectsForUser,
  storeAuthAttempt,
  upsertOrganizationMembership,
  upsertPlatformOrganization,
  upsertPlatformUser,
} from './repository'

const OWNER: PlatformUser = {
  id: 'user_owner',
  email: 'owner@example.com',
  name: 'Agency Owner',
  avatarUrl: null,
}

const ORGANIZATION: PlatformOrganization = {
  id: 'org_agency',
  name: 'Example Agency',
  slug: 'example-agency',
  role: 'owner',
}

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, platformSqliteMigrations)
  await upsertPlatformUser(db, OWNER)
  await upsertPlatformOrganization(db, ORGANIZATION)
  await upsertOrganizationMembership(db, {
    organizationId: ORGANIZATION.id,
    userId: OWNER.id,
    role: 'owner',
  })
  return db
}

describe('control-plane migrations', () => {
  it('keeps Postgres and SQLite migration IDs in lockstep', () => {
    expect(platformPgMigrations.map(({ id }) => id)).toEqual(
      platformSqliteMigrations.map(({ id }) => id),
    )
  })
})

describe('platform project repository', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('creates the project ownership, first revision, and two environments atomically', async () => {
    const project = await createProject(db, {
      organizationId: ORGANIZATION.id,
      userId: OWNER.id,
      name: 'Northstar Studio',
      clientName: 'Northstar AB',
      sourceMode: 'local_bridge',
    })

    expect(project.slug).toBe('northstar-studio')
    expect(project.role).toBe('manager')
    expect(project.latestRevision).toBe(1)
    expect(project.workspaceState).toBe('unprovisioned')

    const { rows: memberships } = await db<{ role: string }>`
      select role from platform_project_memberships where project_id = ${project.id}
    `
    const { rows: revisions } = await db<{ sequence: number }>`
      select sequence from platform_project_revisions where project_id = ${project.id}
    `
    const { rows: environments } = await db<{ kind: string }>`
      select kind from platform_environments where project_id = ${project.id} order by kind
    `

    expect(memberships).toEqual([{ role: 'manager' }])
    expect(revisions).toEqual([{ sequence: 1 }])
    expect(environments).toEqual([{ kind: 'preview' }, { kind: 'production' }])
  })

  it('allocates project slugs within an organization', async () => {
    const first = await createProject(db, {
      organizationId: ORGANIZATION.id,
      userId: OWNER.id,
      name: 'Client Site',
      sourceMode: 'github',
    })
    const second = await createProject(db, {
      organizationId: ORGANIZATION.id,
      userId: OWNER.id,
      name: 'Client Site',
      sourceMode: 'github',
    })

    expect(first.slug).toBe('client-site')
    expect(second.slug).toBe('client-site-2')
  })

  it('limits ordinary members to projects where they have a project role', async () => {
    const member: PlatformUser = {
      id: 'user_member',
      email: 'member@example.com',
      name: 'Agency Member',
      avatarUrl: null,
    }
    await upsertPlatformUser(db, member)
    await upsertOrganizationMembership(db, {
      organizationId: ORGANIZATION.id,
      userId: member.id,
      role: 'member',
    })
    const visible = await createProject(db, {
      organizationId: ORGANIZATION.id,
      userId: member.id,
      name: 'Visible Project',
      sourceMode: 'instatic',
    })
    await createProject(db, {
      organizationId: ORGANIZATION.id,
      userId: OWNER.id,
      name: 'Private Project',
      sourceMode: 'instatic',
    })

    const projects = await listProjectsForUser(
      db,
      { ...ORGANIZATION, role: 'member' },
      member.id,
    )

    expect(projects.map(({ id }) => id)).toEqual([visible.id])
  })
})

describe('platform authentication attempts', () => {
  it('consumes a PKCE verifier exactly once', async () => {
    const db = await freshDb()
    await storeAuthAttempt(db, {
      state: 'opaque-workos-state',
      codeVerifier: 'pkce-verifier',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(await consumeAuthAttempt(db, 'opaque-workos-state')).toBe('pkce-verifier')
    expect(await consumeAuthAttempt(db, 'opaque-workos-state')).toBeNull()
  })

  it('rejects an expired PKCE verifier', async () => {
    const db = await freshDb()
    await storeAuthAttempt(db, {
      state: 'expired-state',
      codeVerifier: 'expired-verifier',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })

    expect(await consumeAuthAttempt(db, 'expired-state')).toBeNull()
  })
})
