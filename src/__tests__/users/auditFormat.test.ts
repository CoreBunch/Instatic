import { describe, expect, it } from 'bun:test'
import type { CmsAuditEvent, CmsCurrentUser, CmsRole } from '@core/persistence'
import { auditTitle } from '@users/utils/audit'

const now = '2026-06-23T12:00:00.000Z'

const memberRole: CmsRole = {
  id: 'member',
  slug: 'member',
  name: 'Member',
  description: 'Member role',
  isSystem: true,
  capabilities: [],
  createdAt: now,
  updatedAt: now,
}

const testUser: CmsCurrentUser = {
  id: 'user_1',
  email: 'test@example.com',
  displayName: 'Test User',
  status: 'active',
  role: memberRole,
  capabilities: [],
  lastLoginAt: null,
  failedLoginCount: 0,
  lockedUntil: null,
  passwordUpdatedAt: null,
  mfaEnabled: false,
  mfaEnabledAt: null,
  mfaRecoveryCodesRemaining: 0,
  stepUpAuthMode: 'required',
  stepUpWindowMinutes: 15,
  avatarMediaId: null,
  avatarUrl: null,
  gravatarHash: '',
  createdAt: now,
  updatedAt: now,
}

const usersById = new Map([[testUser.id, testUser]])
const rolesById = new Map([[memberRole.id, memberRole]])

function auditEvent(overrides: Partial<CmsAuditEvent>): CmsAuditEvent {
  return {
    id: `audit-${overrides.action ?? 'unknown'}`,
    actorUserId: testUser.id,
    action: 'publish',
    targetType: null,
    targetId: null,
    metadata: {},
    actorLabel: 'Test User',
    targetLabel: null,
    metadataLabels: {},
    ipAddress: null,
    userAgent: null,
    createdAt: now,
    ...overrides,
  }
}

describe('audit event formatting', () => {
  it('renders emitted audit action families as readable titles instead of raw action ids', () => {
    const cases: Array<{ event: CmsAuditEvent; expected: string }> = [
      {
        event: auditEvent({
          action: 'login.locked',
          targetType: 'user',
          targetId: testUser.id,
          metadata: { email: testUser.email },
        }),
        expected: 'Test User was locked',
      },
      {
        event: auditEvent({
          action: 'login.rate_limited',
          actorUserId: null,
          targetType: 'user',
          metadata: { email: 'blocked@example.com' },
        }),
        expected: 'Login rate limit hit for blocked@example.com',
      },
      {
        event: auditEvent({
          action: 'data.table.create',
          targetType: 'data_table',
          targetId: 'posts',
          metadata: { slug: 'posts' },
        }),
        expected: 'Data table posts was created',
      },
      {
        event: auditEvent({
          action: 'data.row.publish',
          targetType: 'data_row',
          targetId: 'row_1',
          metadata: { tableId: 'posts', slug: 'launch-post' },
        }),
        expected: 'Data row launch-post was published',
      },
      {
        event: auditEvent({
          action: 'data.author.assign',
          targetType: 'data_row',
          targetId: 'row_1',
          metadata: { tableId: 'posts', slug: 'launch-post', authorUserId: testUser.id },
        }),
        expected: 'Data row launch-post author changed',
      },
      {
        event: auditEvent({
          action: 'plugin.pack.install',
          targetType: 'plugin',
          targetId: 'acme.gallery',
          metadata: { pluginId: 'acme.gallery' },
        }),
        expected: 'acme.gallery pack was installed',
      },
      {
        event: auditEvent({
          action: 'plugin.settings.update',
          targetType: 'plugin',
          targetId: 'acme.gallery',
          metadata: { pluginId: 'acme.gallery' },
        }),
        expected: 'acme.gallery settings were updated',
      },
      {
        event: auditEvent({
          action: 'plugin.resource.update',
          targetType: 'plugin',
          targetId: 'instatic.csp-manager',
          metadata: { pluginId: 'instatic.csp-manager', resourceId: 'sources', recordId: 'source_1' },
        }),
        expected: 'instatic.csp-manager resource record was updated',
      },
      {
        event: auditEvent({
          action: 'ai.default.updated',
          targetType: 'ai_default',
          targetId: 'site',
          metadata: { scope: 'site' },
        }),
        expected: 'AI default for site was updated',
      },
      {
        event: auditEvent({
          action: 'ai.credential.deleted',
          targetType: 'ai_credential',
          targetId: 'cred_1',
          metadata: { displayLabel: 'Local Ollama' },
        }),
        expected: 'AI credential Local Ollama was deleted',
      },
      {
        event: auditEvent({
          action: 'ai.chat.failed',
          targetType: 'ai_conversation',
          targetId: 'conversation_1',
          metadata: { scope: 'site' },
        }),
        expected: 'AI chat in site failed',
      },
    ]

    for (const { event, expected } of cases) {
      expect(auditTitle(event, usersById, rolesById)).toBe(expected)
      expect(auditTitle(event, usersById, rolesById)).not.toBe(event.action)
    }
  })

  it('humanizes unknown future action ids instead of rendering the raw dotted id', () => {
    const event = auditEvent({ action: 'plugin.future.action' })

    expect(auditTitle(event, usersById, rolesById)).toBe('Plugin future action')
  })
})
