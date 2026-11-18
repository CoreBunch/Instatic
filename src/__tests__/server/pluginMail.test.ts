/**
 * Email for plugins, end to end: a real plugin package installed through the
 * cms handler, running in its sandboxed worker, against a real database.
 *
 * Covers declaring templates, sending one to a member and to an address, the
 * permission each needs, what a hostile value can and cannot do, the limits,
 * the outcome events, the owner's edits across an upgrade, and what
 * disabling and uninstalling leave behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { getMailTemplateDefinition, type MailConnector, type MailTemplate } from '@core/mail'
import { hookBus } from '@core/plugins/hookBus'
import { parsePluginManifest } from '@core/plugins/manifest'
import { undeclaredMailVariables } from '@core/plugins/manifestMail'
import { configurePublicOrigins, resetPublicOrigins } from '../../../server/auth/security'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { listMailActivity } from '../../../server/mail/activity'
import { createMailConnector } from '../../../server/mail/connectors'
import { saveMailDefaults } from '../../../server/mail/defaults'
import { __resetMailQueuePauseForTesting, drainMailQueue, queueTemplateMail } from '../../../server/mail/delivery'
import { MAIL_BACKLOG_LIMIT, MailLimitError } from '../../../server/mail/limits'
import type { MailCarrier } from '../../../server/mail/send'
import { MailDeliveryError } from '../../../server/mail/smtpDriver'
import { createMember } from '../../../server/members/repository'
import { handleServerRequest } from '../../../server/router'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const ORIGIN = 'http://localhost'
const PLUGIN_ID = 'acme.desk'
const MOUNT = `/_instatic/plugins/${PLUGIN_ID}`
const BASE = ['cms.routes', 'cms.routes.public', 'cms.hooks']
const BOTH = [...BASE, 'mail.send', 'mail.send.external']
const REPLY_KEY = `plugin.${PLUGIN_ID}~ticket.reply`

const PLUGIN_SOURCE = `
  export function activate(api) {
    const heard = []
    for (const event of ['mail.delivered', 'mail.failed']) {
      api.cms.hooks.on(event, (payload) => { heard.push({ event, ...payload }) })
    }
    api.cms.routes.public.get('/heard', () => ({ heard }))
    api.cms.routes.public.get('/site', async () => ({ url: await api.cms.site.publicUrl() }))
    api.cms.routes.public.post('/send', async (ctx) => {
      try {
        return { status: await api.cms.mail.send(ctx.body) }
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) }
      }
    })
  }
`

const TEMPLATES = [
  {
    key: 'ticket.reply',
    label: 'Ticket reply',
    description: 'Sent to the customer when the team answers a ticket.',
    variables: [
      { name: 'subject', label: 'Ticket subject', sample: 'Publishing stops at 80%' },
      { name: 'link', label: 'Link to the ticket', sample: 'https://example.com/account/support/1042' },
    ],
    subject: 'Re: {subject}',
    body: 'We answered **{subject}**.\n\n[Open the ticket]({link})',
  },
  {
    key: 'ticket.opened',
    label: 'New ticket',
    description: 'Sent to the support inbox when a customer opens a ticket.',
    variables: [{ name: 'subject', label: 'Ticket subject', sample: 'Publishing stops at 80%' }],
    subject: 'New ticket: {subject}',
    body: 'A customer opened **{subject}**.',
  },
]

function manifest(permissions: string[], overrides: Record<string, unknown> = {}) {
  return {
    id: PLUGIN_ID,
    name: 'Help Desk',
    version: '1.0.0',
    apiVersion: 1,
    permissions,
    entrypoints: { server: 'server/index.js' },
    resources: [],
    adminPages: [],
    mail: { templates: TEMPLATES },
    ...overrides,
  }
}

describe('email for plugins', () => {
  let h: CapabilityTestHarness
  let owner: string
  let uploadsDir: string
  let now = 0

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'plugin-mail-'))
    h = await createCapabilityTestHarness({ uploadsDir })
    owner = await h.setupOwner()
    hookBus.reset()
    resetPublicOrigins()
    __resetMailQueuePauseForTesting()
    now = Date.now() + 5_000
  })

  afterEach(async () => {
    resetPublicOrigins()
    await h.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function install(permissions: string[], overrides: Record<string, unknown> = {}): Promise<Response> {
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest(permissions, overrides))),
      'server/index.js': strToU8(PLUGIN_SOURCE),
    })
    const formData = new FormData()
    formData.set('file', new File([zipped], 'plugin.zip', { type: 'application/zip' }))
    formData.set('grantedPermissions', JSON.stringify(permissions))
    const req = {
      url: `${ORIGIN}/admin/api/cms/plugins/package`,
      method: 'POST',
      headers: { get: (name: string) => (name.toLowerCase() === 'cookie' ? owner : null) },
      formData: async () => formData,
    } as unknown as Request
    return handleCmsRequest(req, h.db, { uploadsDir })
  }

  async function call(path: string, json?: unknown): Promise<Record<string, unknown>> {
    const req = new Request(`${ORIGIN}${MOUNT}${path}`, {
      method: json === undefined ? 'GET' : 'POST',
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    })
    if (json !== undefined) {
      req.headers.set('content-type', 'application/json')
      req.headers.set('origin', ORIGIN)
    }
    const res = await handleServerRequest(req, { db: h.db, uploadsDir })
    return (await res.json()) as Record<string, unknown>
  }

  const send = (body: unknown) => call('/send', body)

  async function readyConnector(): Promise<MailConnector> {
    const { rows } = await h.db<{ id: string }>`select id from users limit 1`
    const connector = await createMailConnector(
      h.db,
      { kind: 'smtp', label: 'Relay', config: { host: 'smtp.example.com', port: 587, username: 'mailer' }, secret: 's' },
      rows[0].id,
    )
    await saveMailDefaults(
      h.db,
      { defaultConnectorId: connector.id, fromAddress: 'hello@example.com', fromName: 'Example', replyTo: '' },
      rows[0].id,
    )
    return connector
  }

  const drain = (carrier: MailCarrier) => drainMailQueue(h.db, { carrier, now: () => now, random: () => 0.5, paceMs: 0 })

  async function activeMember(email = 'ada@example.com'): Promise<string> {
    const created = await createMember(h.db, { email, passwordHash: 'x', profile: {}, verified: true })
    return created!.id
  }

  async function templates(): Promise<MailTemplate[]> {
    const res = await h.cms('/admin/api/cms/mail/templates', { cookie: owner })
    return (await readJson<{ templates: MailTemplate[] }>(res)).templates
  }

  describe('the manifest', () => {
    it('refuses templates without a mail permission, duplicate keys and the site\'s own variables', () => {
      expect(() => parsePluginManifest(manifest(BASE))).toThrow('neither the `mail.send` nor the `mail.send.external`')
      expect(() => parsePluginManifest(manifest(BOTH, { mail: { templates: [TEMPLATES[0], TEMPLATES[0]] } })))
        .toThrow('declared twice')
      const stealsSite = { ...TEMPLATES[1], variables: [{ name: 'site.name', label: 'Site', sample: 'x' }] }
      expect(() => parsePluginManifest(manifest(BOTH, { mail: { templates: [stealsSite] } }))).toThrow('filled in by the site')
    })

    it('refuses a subject that spans lines and an empty list, and drops a field it does not know', () => {
      const twoLines = { ...TEMPLATES[0], subject: 'Hi\nBcc: someone@example.com' }
      expect(() => parsePluginManifest(manifest(BOTH, { mail: { templates: [twoLines] } }))).toThrow()
      expect(() => parsePluginManifest(manifest(BOTH, { mail: { templates: [] } }))).toThrow()
      // A plugin cannot smuggle in a sender or a header: unknown fields never reach the host.
      const parsed = parsePluginManifest(manifest(BOTH, { mail: { templates: [{ ...TEMPLATES[0], from: 'x@example.com' }] } }))
      expect(parsed.mail?.templates[0]).not.toHaveProperty('from')
    })

    it('tells the lint which names a template uses without declaring them', () => {
      expect(undeclaredMailVariables(TEMPLATES[0])).toEqual([])
      expect(undeclaredMailVariables({ ...TEMPLATES[0], body: '{link} {tikcet} {site.name}' })).toEqual(['tikcet'])
    })
  })

  describe('templates in the Email workspace', () => {
    it('lists a loaded plugin\'s templates under its name, with samples, and sends a test of one', async () => {
      expect((await install(BOTH)).status).toBe(201)
      const listed = (await templates()).filter((template) => template.group === 'Help Desk')
      expect(listed.map((template) => template.key).sort()).toEqual([`plugin.${PLUGIN_ID}~ticket.opened`, REPLY_KEY])
      expect(listed.find((template) => template.key === REPLY_KEY)).toMatchObject({
        label: 'Ticket reply', subject: 'Re: {subject}', customised: false,
      })

      const test = await h.cms(`/admin/api/cms/mail/templates/${REPLY_KEY}/test`, {
        method: 'POST', cookie: owner, json: { to: 'owner@example.com' },
      })
      expect(test.status).toBe(200)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        kind: REPLY_KEY, kindLabel: 'Ticket reply', subject: 'Re: Publishing stops at 80%',
      })
    })

    it('keeps the owner\'s wording across an upgrade and uses it when the plugin sends', async () => {
      await install(BOTH)
      const put = await h.cms(`/admin/api/cms/mail/templates/${REPLY_KEY}`, {
        method: 'PUT', cookie: owner, json: { subject: 'Answer: {subject}', body: 'Our words. [Ticket]({link})' },
      })
      expect(put.status).toBe(200)

      expect((await install(BOTH, { version: '1.1.0' })).status).toBeLessThan(300)
      expect((await templates()).find((template) => template.key === REPLY_KEY)).toMatchObject({
        subject: 'Answer: {subject}', customised: true,
      })

      const memberId = await activeMember()
      expect(await send({ template: 'ticket.reply', to: { member: memberId }, variables: { subject: 'Hello', link: 'https://example.com/t/1' } }))
        .toEqual({ status: 'captured' })
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ subject: 'Answer: Hello', to: 'ada@example.com' })
    })

    it('takes the templates out while the plugin is disabled and deletes the edits on uninstall', async () => {
      await install(BOTH)
      await h.cms(`/admin/api/cms/mail/templates/${REPLY_KEY}`, {
        method: 'PUT', cookie: owner, json: { subject: 'Edited', body: 'Edited' },
      })
      const disabled = await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'PATCH', cookie: owner, json: { enabled: false } })
      expect(disabled.status).toBe(200)
      expect(getMailTemplateDefinition(REPLY_KEY)).toBeUndefined()
      expect((await templates()).some((template) => template.key === REPLY_KEY)).toBe(false)
      // The edit waits for the plugin to come back.
      expect((await h.db`select template_key from mail_templates`).rows).toHaveLength(1)

      const removed = await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'DELETE', cookie: owner })
      expect(removed.status).toBe(200)
      expect((await h.db`select template_key from mail_templates`).rows).toHaveLength(0)
    })
  })

  describe('sending', () => {
    it('queues a template for a member, whose address the host looks up, and for an address', async () => {
      await install(BOTH)
      await readyConnector()
      const memberId = await activeMember()
      expect(await send({ template: 'ticket.reply', to: { member: memberId }, variables: { subject: 'Hi', link: 'https://example.com/t/1' }, reference: 'ticket-1' }))
        .toEqual({ status: 'queued' })
      expect(await send({ template: 'ticket.opened', to: { address: 'support@example.com' }, variables: { subject: 'Hi' } }))
        .toEqual({ status: 'queued' })

      const { rows } = await h.db<{ to_address: string; source: string; lane: number; reference: string | null }>`
        select to_address, source, lane, reference from mail_queue order by outbox_id
      `
      expect(rows).toEqual([
        { to_address: 'ada@example.com', source: PLUGIN_ID, lane: 1, reference: 'ticket-1' },
        { to_address: 'support@example.com', source: PLUGIN_ID, lane: 1, reference: null },
      ])

      const carried: Array<{ to: string; subject: string; text: string }> = []
      await drain(async (_c, _s, mail) => { carried.push({ to: mail.to, subject: mail.subject, text: mail.text }); return null })
      expect(carried.map((mail) => `${mail.to} | ${mail.subject}`)).toEqual([
        'ada@example.com | Re: Hi',
        'support@example.com | New ticket: Hi',
      ])
      expect(carried[0].text).toContain('https://example.com/t/1')
    })

    it('needs mail.send for a member and mail.send.external for an address', async () => {
      await install([...BASE, 'mail.send'])
      const memberId = await activeMember()
      expect(await send({ template: 'ticket.reply', to: { member: memberId }, variables: { subject: 'a', link: 'https://example.com/' } }))
        .toEqual({ status: 'captured' })
      const refused = await send({ template: 'ticket.opened', to: { address: 'support@example.com' }, variables: { subject: 'a' } })
      expect(String(refused.error)).toContain('mail.send.external')
    })

    it('needs mail.send even when the plugin may write to any address', async () => {
      await install([...BASE, 'mail.send.external'])
      const memberId = await activeMember()
      const refused = await send({ template: 'ticket.reply', to: { member: memberId }, variables: { subject: 'a', link: 'https://example.com/' } })
      expect(String(refused.error)).toContain('"mail.send"')
    })

    it('refuses a template it does not declare, another plugin\'s and the core\'s, and an undeclared variable', async () => {
      await install(BOTH)
      const to = { address: 'someone@example.com' }
      expect(String((await send({ template: 'nope', to })).error)).toContain('not an email template this plugin declares')
      expect(String((await send({ template: 'member.reset', to, variables: { link: 'https://evil.example/' } })).error))
        .toContain('not an email template this plugin declares')
      expect(String((await send({ template: 'plugin.other.plugin.welcome', to })).error))
        .toContain('not an email template this plugin declares')
      expect(String((await send({ template: 'ticket.opened', to, variables: { subject: 'a', 'site.name': 'Bank' } })).error))
        .toContain('no variable named "site.name"')
      expect((await listMailActivity(h.db)).entries).toHaveLength(0)
    })

    it('refuses a deleted, suspended or unknown member, a bad address and a recipient of neither kind', async () => {
      await install(BOTH)
      const suspended = await activeMember('s@example.com')
      await h.db`update members set status = 'suspended' where id = ${suspended}`
      const variables = { subject: 'a', link: 'https://example.com/' }
      expect(String((await send({ template: 'ticket.reply', to: { member: suspended }, variables })).error)).toContain('cannot be emailed')
      expect(String((await send({ template: 'ticket.reply', to: { member: 'nobody' }, variables })).error)).toContain('cannot be emailed')
      for (const address of ['not-an-address', 'a@example.com, b@example.com', 'a@example.com\nBcc: b@example.com']) {
        expect((await send({ template: 'ticket.opened', to: { address }, variables: { subject: 'a' } })).error).toBeDefined()
      }
      expect(String((await send({ template: 'ticket.opened', to: {}, variables: { subject: 'a' } })).error)).toContain('needs `to')
      expect(String((await send({ template: 'ticket.opened', to: { member: 'x', address: 'a@example.com' }, variables: { subject: 'a' } })).error))
        .toContain('needs `to')
      expect((await listMailActivity(h.db)).entries).toHaveLength(0)
    })

    it('keeps a hostile value from adding markup, a header or a link of its own', async () => {
      await install(BOTH)
      await readyConnector()
      const memberId = await activeMember()
      expect(await send({
        template: 'ticket.reply',
        to: { member: memberId },
        variables: { subject: '<img src=x onerror=alert(1)> **bold**\r\nBcc: evil@example.com', link: 'javascript:alert(1)' },
      })).toEqual({ status: 'queued' })
      let subject = ''
      let html = ''
      await drain(async (_c, _s, mail) => { subject = mail.subject; html = mail.html ?? ''; return null })
      expect(subject).not.toMatch(/[\r\n]/)
      expect(html).not.toContain('<img')
      expect(html).not.toContain('<strong>bold')
      expect(html).not.toContain('javascript:')
      expect(html).toContain('href="#"')
    })

    it('says so when email is not set up on a production server', async () => {
      await install(BOTH)
      const before = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        expect(String((await send({ template: 'ticket.opened', to: { address: 'a@example.com' }, variables: { subject: 'a' } })).error))
          .toContain('Email is not set up')
      } finally {
        process.env.NODE_ENV = before
      }
    })
  })

  describe('limits', () => {
    const hour = () => new Date().toISOString().slice(0, 13)
    const counter = async (scope: string, bucket: string) => {
      const { rows } = await h.db<{ count: number }>`
        select count from mail_counters where source = ${PLUGIN_ID} and scope = ${scope} and bucket = ${bucket}
      `
      return rows[0] ? Number(rows[0].count) : null
    }
    const attempt = (to: string) =>
      queueTemplateMail(h.db, {
        key: `plugin.${PLUGIN_ID}~ticket.opened`, to, variables: { subject: 'a' }, source: PLUGIN_ID,
      }).then((status) => status, (err: unknown) => (err instanceof MailLimitError ? 'refused' : 'error'))

    it('stops at twenty emails to one recipient in a clock hour, per plugin and without regard to case', async () => {
      await install(BOTH)
      const mail = { template: 'ticket.opened', variables: { subject: 'a' } }
      for (let index = 0; index < 20; index += 1) {
        const to = { address: index % 2 === 0 ? 'Busy@Example.com' : 'busy@example.com' }
        expect(await send({ ...mail, to })).toEqual({ status: 'captured' })
      }
      expect(String((await send({ ...mail, to: { address: 'busy@example.com' } })).error))
        .toContain('20 emails to that recipient this hour')
      expect(await counter('to:busy@example.com', hour())).toBe(20)
      expect(await send({ ...mail, to: { address: 'calm@example.com' } })).toEqual({ status: 'captured' })
      expect((await listMailActivity(h.db)).matching).toBe(21)
    })

    it('accepts exactly twenty of forty sends made at once', async () => {
      await install(BOTH)
      await readyConnector()
      const results = await Promise.all(Array.from({ length: 40 }, () => attempt('rush@example.com')))
      expect(results.filter((result) => result === 'queued')).toHaveLength(20)
      expect(results.filter((result) => result === 'refused')).toHaveLength(20)
      expect((await h.db`select id from mail_queue`).rows).toHaveLength(20)
      // A refused send took no place in the backlog and left no row in the log.
      expect(await counter('backlog', '')).toBe(20)
      expect((await listMailActivity(h.db)).matching).toBe(20)
    })

    it('forgets the hours that are over', async () => {
      await install(BOTH)
      await h.db`insert into mail_counters (source, scope, bucket, count) values (${PLUGIN_ID}, 'to:old@example.com', '2020-01-01T00', 20)`
      expect(await send({ template: 'ticket.opened', to: { address: 'old@example.com' }, variables: { subject: 'a' } }))
        .toEqual({ status: 'captured' })
      expect(await counter('to:old@example.com', '2020-01-01T00')).toBeNull()
    })

    it('stops when the plugin has ten thousand emails waiting, however many arrive at once', async () => {
      await install(BOTH)
      await readyConnector()
      await h.db`insert into mail_counters (source, scope, bucket, count) values (${PLUGIN_ID}, 'backlog', '', ${MAIL_BACKLOG_LIMIT - 10})`
      const results = await Promise.all(Array.from({ length: 30 }, (_, index) => attempt(`r${index}@example.com`)))
      expect(results.filter((result) => result === 'queued')).toHaveLength(10)
      expect(results.filter((result) => result === 'refused')).toHaveLength(20)
      expect(await counter('backlog', '')).toBe(MAIL_BACKLOG_LIMIT)
      expect(String((await send({ template: 'ticket.opened', to: { address: 'late@example.com' }, variables: { subject: 'a' } })).error))
        .toContain('10,000 emails waiting')
      // A refusal for the backlog gives the recipient's place back too: nothing was accepted.
      expect(await counter('to:late@example.com', hour())).toBeNull()
    })

    it('gives a place in the backlog back when an email leaves the queue, sent or failed', async () => {
      await install(BOTH)
      await readyConnector()
      await send({ template: 'ticket.opened', to: { address: 'ok@example.com' }, variables: { subject: 'a' } })
      await send({ template: 'ticket.opened', to: { address: 'bad@example.com' }, variables: { subject: 'a' } })
      expect(await counter('backlog', '')).toBe(2)
      await drain(async (_c, _s, mail) => {
        if (mail.to === 'bad@example.com') throw new MailDeliveryError('Rejected.')
        return null
      })
      expect(await counter('backlog', '')).toBe(0)
    })
  })

  describe('outcome events', () => {
    it('tells the plugin, and only that plugin, what became of its email', async () => {
      await install(BOTH)
      await readyConnector()
      const elsewhere: unknown[] = []
      hookBus.on('other.plugin', 'mail.delivered', async (payload) => { elsewhere.push(payload) })
      hookBus.on('other.plugin', 'mail.failed', async (payload) => { elsewhere.push(payload) })

      await send({ template: 'ticket.opened', to: { address: 'ok@example.com' }, variables: { subject: 'a' }, reference: 'r-ok' })
      await send({ template: 'ticket.opened', to: { address: 'bad@example.com' }, variables: { subject: 'a' }, reference: 'r-bad' })
      await drain(async (_c, _s, mail) => {
        if (mail.to === 'bad@example.com') throw new MailDeliveryError('The SMTP server rejected the recipient address.')
        return null
      })
      await new Promise((resolve) => setTimeout(resolve, 50))

      const { heard } = await call('/heard')
      expect(heard).toEqual([
        { event: 'mail.delivered', template: 'ticket.opened', to: { address: 'ok@example.com' }, reference: 'r-ok' },
        // A fixed code: the provider's sentence stays in the admin's Activity.
        { event: 'mail.failed', template: 'ticket.opened', to: { address: 'bad@example.com' }, reference: 'r-bad', reason: 'recipient_rejected' },
      ])
      expect(elsewhere).toEqual([])
      expect((await listMailActivity(h.db, { status: 'failed' })).entries[0].error)
        .toBe('The SMTP server rejected the recipient address.')
    })

    it('never hands a member\'s address to the plugin that emailed them by id', async () => {
      // No `members.read`: this plugin was never entitled to the address.
      await install([...BASE, 'mail.send'])
      await readyConnector()
      const reached = await activeMember('private.person@example.com')
      const bounced = await activeMember('bounces@example.com')
      const variables = { subject: 'a', link: 'https://example.com/t' }
      expect(await send({ template: 'ticket.reply', to: { member: reached }, variables, reference: 'r1' })).toEqual({ status: 'queued' })
      expect(await send({ template: 'ticket.reply', to: { member: bounced }, variables, reference: 'r2' })).toEqual({ status: 'queued' })
      await drain(async (_c, _s, mail) => {
        // A provider's own reason can quote the recipient, in any case.
        if (mail.to === 'bounces@example.com') {
          throw new MailDeliveryError('Resend refused the message (HTTP 422). Invalid `to` field: Bounces@Example.com')
        }
        return null
      })
      await new Promise((resolve) => setTimeout(resolve, 50))

      const { heard } = await call('/heard')
      expect(heard).toEqual([
        { event: 'mail.delivered', template: 'ticket.reply', to: { member: reached }, reference: 'r1' },
        { event: 'mail.failed', template: 'ticket.reply', to: { member: bounced }, reference: 'r2', reason: 'recipient_rejected' },
      ])
      // No part of the provider's sentence reaches the plugin: not the address, its local part or its domain.
      expect(JSON.stringify(heard)).not.toContain('Resend')
      expect(JSON.stringify(heard).toLowerCase()).not.toContain('bounces')
      expect(JSON.stringify(heard).toLowerCase()).not.toContain('example.com')

      // Refusals do not carry it either.
      await h.db`update members set status = 'suspended' where id = ${reached}`
      const refused = await send({ template: 'ticket.reply', to: { member: reached }, variables })
      expect(JSON.stringify(refused)).not.toContain('private.person')
      for (let index = 0; index < 19; index += 1) {
        await send({ template: 'ticket.reply', to: { member: bounced }, variables })
      }
      const limited = await send({ template: 'ticket.reply', to: { member: bounced }, variables })
      expect(String(limited.error)).toContain('this hour')
      expect(JSON.stringify(limited)).not.toContain('bounces')
    })

    it('counts a member and an address apart, so a refusal cannot tell which address a member has', async () => {
      await install(BOTH)
      const memberId = await activeMember('secret.inbox@example.com')
      const toMember = { template: 'ticket.reply', to: { member: memberId }, variables: { subject: 'a', link: 'https://example.com/t' } }
      const toAddress = { template: 'ticket.opened', to: { address: 'secret.inbox@example.com' }, variables: { subject: 'a' } }
      for (let index = 0; index < 20; index += 1) expect(await send(toMember)).toEqual({ status: 'captured' })
      expect(String((await send(toMember)).error)).toContain('this hour')

      // The member's places are used up; the address's are untouched, as for any other address.
      expect(await send(toAddress)).toEqual({ status: 'captured' })
      expect(await send({ ...toAddress, to: { address: 'someone.else@example.com' } })).toEqual({ status: 'captured' })
      const { rows } = await h.db<{ scope: string; count: number }>`
        select scope, count from mail_counters where source = ${PLUGIN_ID} order by scope
      `
      expect(rows.map((row) => `${row.scope}=${Number(row.count)}`)).toEqual([
        `member:${memberId}=20`,
        'to:secret.inbox@example.com=1',
        'to:someone.else@example.com=1',
      ])
    })

    it('reports an email that ran out of time as expired and a removed template as template_removed', async () => {
      await install(BOTH)
      await readyConnector()
      // First a template that is gone by the time the email is sent.
      await send({ template: 'ticket.opened', to: { address: 'gone@example.com' }, variables: { subject: 'a' }, reference: 'gone' })
      await h.db`update mail_queue set kind = ${`plugin.${PLUGIN_ID}~no.longer.declared`}`
      await drain(async () => null)

      // Then a provider that stays down past the email's day.
      await send({ template: 'ticket.opened', to: { address: 'slow@example.com' }, variables: { subject: 'a' }, reference: 'slow' })
      const down: MailCarrier = async () => {
        throw new MailDeliveryError('Could not reach the provider at smtp.example.com.', { retry: 'later' })
      }
      for (let round = 0; round < 40 && (await h.db`select id from mail_queue`).rows.length > 0; round += 1) {
        await drain(down)
        now += 8 * 60 * 60 * 1000
      }
      await new Promise((resolve) => setTimeout(resolve, 50))

      const { heard } = await call('/heard')
      expect(heard).toEqual([
        { event: 'mail.failed', template: 'no.longer.declared', to: { address: 'gone@example.com' }, reference: 'gone', reason: 'template_removed' },
        { event: 'mail.failed', template: 'ticket.opened', to: { address: 'slow@example.com' }, reference: 'slow', reason: 'expired' },
      ])
    })
  })

  describe('a plugin that goes away', () => {
    it('fails what a disabled plugin left waiting, and says why', async () => {
      await install(BOTH)
      await readyConnector()
      await send({ template: 'ticket.opened', to: { address: 'a@example.com' }, variables: { subject: 'a' } })
      await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'PATCH', cookie: owner, json: { enabled: false } })
      let calls = 0
      await drain(async () => { calls += 1; return null })
      expect(calls).toBe(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        status: 'failed',
        error: 'The template of this email no longer exists: the plugin it belongs to was disabled or removed.',
      })
    })

    it('takes an uninstalled plugin\'s waiting email out of the queue', async () => {
      await install(BOTH)
      await readyConnector()
      await send({ template: 'ticket.opened', to: { address: 'a@example.com' }, variables: { subject: 'a' } })
      await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'DELETE', cookie: owner })
      expect((await h.db`select id from mail_queue`).rows).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        status: 'failed', error: 'The plugin that asked for this email was uninstalled before it was sent.',
      })
    })
  })

  describe('two plugins with related ids', () => {
    it('keeps `acme.desk` from touching the templates of `acme.desk.pro`', async () => {
      await install(BOTH)
      const pro = zipSync({
        'plugin.json': strToU8(JSON.stringify({ ...manifest(BOTH), id: 'acme.desk.pro', name: 'Desk Pro' })),
        'server/index.js': strToU8('export function activate() {}'),
      })
      const formData = new FormData()
      formData.set('file', new File([pro], 'plugin.zip', { type: 'application/zip' }))
      formData.set('grantedPermissions', JSON.stringify(BOTH))
      const req = {
        url: `${ORIGIN}/admin/api/cms/plugins/package`,
        method: 'POST',
        headers: { get: (name: string) => (name.toLowerCase() === 'cookie' ? owner : null) },
        formData: async () => formData,
      } as unknown as Request
      expect((await handleCmsRequest(req, h.db, { uploadsDir })).status).toBe(201)
      const proKey = 'plugin.acme.desk.pro~ticket.reply'
      await h.cms(`/admin/api/cms/mail/templates/${proKey}`, {
        method: 'PUT', cookie: owner, json: { subject: 'Pro wording', body: 'Pro' },
      })

      // A key that would have collided under a dotted prefix is not a template of acme.desk.
      expect(String((await send({ template: 'pro~ticket.reply', to: { address: 'a@example.com' } })).error))
        .toContain('not an email template this plugin declares')

      await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'DELETE', cookie: owner })
      expect(getMailTemplateDefinition(REPLY_KEY)).toBeUndefined()
      expect(getMailTemplateDefinition(proKey)).toBeDefined()
      expect((await templates()).find((template) => template.key === proKey)).toMatchObject({ subject: 'Pro wording' })
    })
  })

  describe('the site address', () => {
    it('gives a plugin the configured public address, or null', async () => {
      await install(BASE, { mail: undefined })
      expect(await call('/site')).toEqual({ url: null })
      configurePublicOrigins(['https://shop.example.com'])
      expect(await call('/site')).toEqual({ url: 'https://shop.example.com' })
    })
  })
})
