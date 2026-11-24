import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { createMailConnector } from '../../../server/mail/connectors'
import { saveMailTemplate } from '../../../server/mail/templates'
import { saveMailDefaults } from '../../../server/mail/defaults'
import { drainMailQueue } from '../../../server/mail/delivery'

describe('admin user invitations', () => {
  let h: CapabilityTestHarness
  let owner: string
  const email = 'invited@example.com'
  const password = 'a-new-password-for-the-invite'
  beforeEach(async () => {
    h = await createCapabilityTestHarness()
    owner = await h.setupOwner()
  })
  afterEach(async () => { await h.cleanup() })

  function invite(delivery: 'link' | 'email' = 'link', roleId = 'client', cookie = owner) {
    return h.cms('/admin/api/cms/users/invite', { method: 'POST', cookie, json: { email, delivery, roleId } })
  }
  function accept(link: string, candidate = password) {
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get('invite')
    return h.cms('/admin/api/cms/auth/invitations/accept', { method: 'POST', json: { token, password: candidate } })
  }
  async function issueLink() {
    const res = await invite()
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    return (await readJson<{ link: string }>(res)).link
  }

  it('replaces pending links and activates the assigned role exactly once', async () => {
    const old = await issueLink()
    const link = await issueLink()
    expect((await accept(old)).status).toBe(400)
    expect((await accept(link, 'short')).status).toBe(400)
    const responses = await Promise.all([accept(link), accept(link)])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400])
    const login = await h.cms('/admin/api/cms/login', { method: 'POST', json: { email, password } })
    expect(login.status).toBe(200)
    expect((await invite()).status).toBe(409)
    const { rows } = await h.db`select status, role_id, invitation_hash from users where email = ${email}`
    expect(rows[0]).toEqual({ status: 'active', role_id: 'client', invitation_hash: null })
  })

  it('rejects expired links, deleted accounts and grants outside the inviter’s authority', async () => {
    const manager = await h.createRoleUser({ name: 'User manager', slug: 'user-manager', capabilities: ['users.manage'] })
    expect((await invite('link', 'admin', await h.stepUp(manager.cookie))).status).toBe(403)
    expect((await invite('link', 'owner')).status).toBe(400)
    const expired = await issueLink()
    await h.db`update users set invitation_expires_at = ${new Date(0)} where email = ${email}`
    expect((await accept(expired)).status).toBe(400)
    const link = await issueLink()
    const { rows } = await h.db<{ id: string }>`select id from users where email = ${email}`
    expect((await h.cms(`/admin/api/cms/users/${rows[0].id}`, { method: 'DELETE', cookie: owner })).status).toBe(200)
    expect((await accept(link)).status).toBe(400)
  })

  it('queues a redeemable invitation only with a configured sender', async () => {
    expect((await invite('email')).status).toBe(409)
    expect((await h.db`select id from users where email = ${email}`).rows).toHaveLength(0)
    const { rows } = await h.db<{ id: string }>`select id from users where role_id = 'owner'`
    const connector = await createMailConnector(h.db, {
      kind: 'smtp', label: 'Test relay', config: { host: 'smtp.example.com', port: 587, username: 'mailer' }, secret: 'test-secret',
    }, rows[0].id)
    await saveMailDefaults(h.db, { defaultConnectorId: connector.id, fromAddress: 'sender@example.com', fromName: '', replyTo: '' }, rows[0].id)
    await saveMailTemplate(h.db, 'user.invite', { subject: 'Invitation {link}', body: '[Accept]({link})' }, rows[0].id)
    const sent = await invite('email')
    expect(sent.status).toBe(201)
    expect(await sent.json()).toEqual({ queued: true })
    const outbox = await h.db`select subject from mail_outbox where kind = 'user.invite'`
    expect(outbox.rows[0].subject).toBe('Invitation [invitation link]')
    let message = ''
    await drainMailQueue(h.db, { carrier: async (_connector, _sender, mail) => {
      expect(mail.to).toBe(email)
      message = mail.text
      return null
    } })
    const link = message.match(/https?:\/\/[^\s()<>]+#invite=[A-Za-z0-9_-]+/)?.[0]
    expect(link).toBeDefined()
    expect((await accept(link!)).status).toBe(200)
  })
})
