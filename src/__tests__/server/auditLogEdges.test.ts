import { describe, expect, it } from 'bun:test'
import { createAuditEvent, listAuditEvents } from '../../../server/repositories/audit'
import {
  createCapabilityTestHarness,
  expectForbidden,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

interface AuditEventPayload {
  id: string
  actorUserId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown>
  actorLabel: string | null
  targetLabel: string | null
  metadataLabels: Record<string, string>
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
}

async function clearAuditEvents(harness: CapabilityTestHarness): Promise<void> {
  await harness.db`delete from audit_events`
}

async function userIdForEmail(harness: CapabilityTestHarness, email: string): Promise<string> {
  const { rows } = await harness.db<{ id: string }>`
    select id from users where email = ${email} limit 1
  `
  const row = rows[0]
  if (!row) throw new Error(`Missing test user ${email}`)
  return row.id
}

async function listAuditPayload(
  harness: CapabilityTestHarness,
  cookie: string,
  path = '/admin/api/cms/audit',
): Promise<AuditEventPayload[]> {
  const res = await harness.cms(path, { cookie })
  expect(res.status).toBe(200)
  const body = await readJson<{ events: AuditEventPayload[] }>(res)
  return body.events
}

describe('audit log edge semantics', () => {
  it('keeps the audit endpoint behind audit.read and GET-only method handling', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const reader = await harness.createRoleUser({
        name: 'Audit Reader',
        slug: `audit-reader-${crypto.randomUUID().slice(0, 8)}`,
        capabilities: ['audit.read'],
      })
      const siteReader = await harness.createRoleUser({
        name: 'Site Reader',
        slug: `site-reader-${crypto.randomUUID().slice(0, 8)}`,
        capabilities: ['site.read'],
      })
      await clearAuditEvents(harness)
      await createAuditEvent(harness.db, {
        actorUserId: null,
        action: 'publish',
        targetType: 'site',
        targetId: 'site',
        metadata: { route: '/' },
        ipAddress: '127.0.0.1',
        userAgent: 'Audit test',
      })

      await expectForbidden(await harness.cms('/admin/api/cms/audit', { cookie: siteReader.cookie }))

      const wrongMethod = await harness.cms('/admin/api/cms/audit', {
        method: 'POST',
        cookie: reader.cookie,
        json: {},
      })
      expect(wrongMethod.status).toBe(405)

      const queriedEvents = await listAuditPayload(
        harness,
        reader.cookie,
        '/admin/api/cms/audit?limit=0&cursor=ignored',
      )
      expect(queriedEvents).toHaveLength(1)
      expect(queriedEvents[0]).toMatchObject({
        action: 'publish',
        metadata: { route: '/' },
      })
    } finally {
      await harness.cleanup()
    }
  })

  it('returns the newest 100 events and drops malformed metadata bags', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      await clearAuditEvents(harness)
      const baseTime = Date.UTC(2026, 5, 23, 12, 0, 0)

      for (let i = 0; i < 105; i += 1) {
        const metadata = i === 104 ? { nested: { unsupported: true } } : { sequence: i }
        await harness.db`
          insert into audit_events (
            id,
            actor_user_id,
            action,
            target_type,
            target_id,
            metadata_json,
            ip_address,
            user_agent,
            created_at
          )
          values (
            ${`audit-edge-${i.toString().padStart(3, '0')}`},
            null,
            ${'publish'},
            ${'site'},
            ${'site'},
            ${metadata},
            null,
            null,
            ${new Date(baseTime + i * 1000).toISOString()}
          )
        `
      }

      const events = await listAuditEvents(harness.db)
      expect(events).toHaveLength(100)
      expect(events[0]?.id).toBe('audit-edge-104')
      expect(events[0]?.metadata).toEqual({})
      expect(events.at(-1)?.id).toBe('audit-edge-005')
    } finally {
      await harness.cleanup()
    }
  })

  it('resolves labels for soft-deleted users and roles deleted after audit capture', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()

      const deletedUserEmail = `audit-deleted-${crypto.randomUUID().slice(0, 8)}@example.com`
      await harness.createUser({
        email: deletedUserEmail,
        displayName: 'Audit Deleted User',
        roleId: 'member',
      })
      const deletedUserId = await userIdForEmail(harness, deletedUserEmail)

      const deletedRoleId = await harness.createRole({
        name: 'Audit Deleted Role',
        slug: `audit-deleted-role-${crypto.randomUUID().slice(0, 8)}`,
        capabilities: ['site.read'],
      })

      const userDelete = await harness.cms(`/admin/api/cms/users/${deletedUserId}`, {
        method: 'DELETE',
        cookie: ownerCookie,
      })
      expect(userDelete.status).toBe(200)

      const roleDelete = await harness.cms(`/admin/api/cms/roles/${deletedRoleId}`, {
        method: 'DELETE',
        cookie: ownerCookie,
      })
      expect(roleDelete.status).toBe(200)

      const events = await listAuditPayload(harness, ownerCookie)
      expect(events.find((event) => event.action === 'user.delete' && event.targetId === deletedUserId))
        .toMatchObject({
          targetLabel: 'Audit Deleted User',
        })
      expect(events.find((event) => event.action === 'role.delete' && event.targetId === deletedRoleId))
        .toMatchObject({
          targetLabel: 'Audit Deleted Role',
          metadata: {
            name: 'Audit Deleted Role',
          },
        })
    } finally {
      await harness.cleanup()
    }
  })
})
