import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  expectForbidden,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import {
  MailConnectorInputSchema,
  registerMailTemplate,
  renderMailTemplate,
  unknownMailVariables,
  type MailActivityResponse,
  type MailConnector,
  type MailOverview,
  type MailTemplate,
} from '@core/mail'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { listMailActivity, recordMail } from '../../../server/mail/activity'
import { sendViaBrevo, sendViaMailgun, sendViaPostmark, sendViaResend } from '../../../server/mail/apiDrivers'
import { createMailConnector, getMailConnector, listMailConnectors, resolveConnector } from '../../../server/mail/connectors'
import { saveMailDefaults } from '../../../server/mail/defaults'
import {
  MailNotConfiguredError,
  sendSiteMail,
  type MailCarrier,
} from '../../../server/mail/send'
import { queueTemplateMail } from '../../../server/mail/delivery'
import { signAwsRequest, sendViaSes } from '../../../server/mail/sesDriver'
import { formatFromHeader, MailDeliveryError, resolveSmtpAddress } from '../../../server/mail/smtpDriver'

const SMTP = {
  kind: 'smtp' as const,
  label: 'Main relay',
  config: { host: 'SMTP.Example.com', port: 587, username: 'mailer' },
  secret: 'smtp-secret-value',
}
const SES = {
  kind: 'ses' as const,
  label: 'AWS',
  config: { region: 'eu-central-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE' },
  secret: 'ses-secret-value',
}
const MESSAGE = {
  kind: 'test',
  to: 'reader@example.com',
  subject: 'Hello',
  text: 'Body with a secret link https://example.com/reset?token=abc',
}

registerMailTemplate({
  key: 'test.welcome',
  label: 'Welcome',
  description: 'Test fixture.',
  group: 'Test',
  variables: [
    { name: 'member.name', label: 'Name', sample: 'Ada' },
    { name: 'link', label: 'Link', sample: 'https://example.com/confirm?token=sample' },
  ],
  defaultSubject: 'Welcome to {site.name}, {member.name}',
  defaultBody: 'Hello **{member.name}**,\n\n[Confirm your address]({link})\n\nOr paste this: {link}',
})

describe('site mail', () => {
  let h: CapabilityTestHarness
  let owner: string

  beforeEach(async () => {
    h = await createCapabilityTestHarness()
    owner = await h.setupOwner()
  })

  afterEach(async () => {
    await h.cleanup()
  })

  async function ownerUserId(): Promise<string> {
    const { rows } = await h.db<{ id: string }>`select id from users limit 1`
    return rows[0].id
  }

  /** A connector that is the default, with a sender address: ready to send. */
  async function readyConnector(): Promise<MailConnector> {
    const userId = await ownerUserId()
    const connector = await createMailConnector(h.db, SMTP, userId)
    await saveMailDefaults(
      h.db,
      { defaultConnectorId: connector.id, fromAddress: 'hello@example.com', fromName: 'Example', replyTo: '' },
      userId,
    )
    return connector
  }

  describe('delivery', () => {
    it('captures the message with its body on a development server with nothing set up', async () => {
      expect(await sendSiteMail(h.db, MESSAGE, { env: { NODE_ENV: 'development' } })).toBe('captured')
      const { entries } = await listMailActivity(h.db)
      expect(entries[0]).toMatchObject({ status: 'captured', to: MESSAGE.to, body: MESSAGE.text, connectorLabel: null })
    })

    it('refuses on a production server with nothing set up and records nothing', async () => {
      await expect(sendSiteMail(h.db, MESSAGE, { env: { NODE_ENV: 'production' } }))
        .rejects.toBeInstanceOf(MailNotConfiguredError)
      expect((await listMailActivity(h.db)).entries).toEqual([])
    })

    it('needs both a connector and a sender address before it sends', async () => {
      const userId = await ownerUserId()
      const connector = await createMailConnector(h.db, SMTP, userId)
      await saveMailDefaults(h.db, { defaultConnectorId: connector.id, fromAddress: '', fromName: '', replyTo: '' }, userId)
      const carrier: MailCarrier = async () => { throw new Error('must not be called') }
      expect(await sendSiteMail(h.db, MESSAGE, { carrier, env: { NODE_ENV: 'development' } })).toBe('captured')
    })

    it('sends through the default connector, as the configured sender, and never stores the body', async () => {
      const connector = await readyConnector()
      const seen: Array<Parameters<MailCarrier>> = []
      const carrier: MailCarrier = async (...args) => {
        seen.push(args)
        return '<provider-id-1>'
      }
      expect(await sendSiteMail(h.db, MESSAGE, { carrier })).toBe('sent')

      const [used, sender] = seen[0]
      expect(used).toMatchObject({ id: connector.id, kind: 'smtp', secret: SMTP.secret })
      expect(used.kind === 'smtp' && used.config.host).toBe('smtp.example.com')
      expect(sender).toEqual({ fromAddress: 'hello@example.com', fromName: 'Example', fromHeader: '"Example" <hello@example.com>', replyTo: '' })
      const { entries, totals } = await listMailActivity(h.db)
      expect(entries[0]).toMatchObject({
        status: 'sent', body: null, error: null, connectorLabel: 'Main relay', providerMessageId: '<provider-id-1>',
      })
      expect(entries[0].durationMs).toBeGreaterThanOrEqual(0)
      expect(totals).toEqual({ queued: 0, sent: 1, failed: 0, captured: 0 })
    })

    it('logs a failed delivery on the connector and in the activity, without the body', async () => {
      const connector = await readyConnector()
      const carrier: MailCarrier = async () => {
        throw new MailDeliveryError('The SMTP server rejected the username or password.')
      }
      await expect(sendSiteMail(h.db, MESSAGE, { carrier })).rejects.toBeInstanceOf(MailDeliveryError)
      const { entries } = await listMailActivity(h.db, { status: 'failed' })
      expect(entries[0]).toMatchObject({ body: null, error: 'The SMTP server rejected the username or password.' })
      const overview = await readJson<{ overview: MailOverview }>(await h.cms('/admin/api/cms/mail', { cookie: owner }))
      expect(overview.overview.connectors.find((c) => c.id === connector.id)?.lastError)
        .toBe('The SMTP server rejected the username or password.')
    })

    it('rejects a recipient or subject that could add headers', async () => {
      const env = { NODE_ENV: 'development' }
      await expect(sendSiteMail(h.db, { ...MESSAGE, subject: 'Hi\r\nBcc: attacker@example.com' }, { env }))
        .rejects.toBeInstanceOf(MailDeliveryError)
      await expect(sendSiteMail(h.db, { ...MESSAGE, to: 'reader@example.com\nBcc: attacker@example.com' }, { env }))
        .rejects.toBeInstanceOf(MailDeliveryError)
      expect((await listMailActivity(h.db)).entries).toEqual([])
    })
  })

  describe('connector storage', () => {
    it('stores each secret encrypted and resolves it only for sending', async () => {
      const userId = await ownerUserId()
      const smtp = await createMailConnector(h.db, SMTP, userId)
      const ses = await createMailConnector(h.db, SES, userId)
      const { rows } = await h.db<{ secret_ciphertext: Uint8Array }>`select secret_ciphertext from mail_connectors`
      for (const row of rows) {
        const stored = Buffer.from(row.secret_ciphertext).toString('utf8')
        expect(stored).not.toContain(SMTP.secret)
        expect(stored).not.toContain(SES.secret)
      }
      expect(JSON.stringify([smtp, ses])).not.toContain('secret-value')
      expect(await resolveConnector(h.db, ses.id)).toMatchObject({ kind: 'ses', secret: SES.secret })
    })
  })

  describe('templates', () => {
    it('fills variables as text: a value can never add markup or a link', () => {
      const rendered = renderMailTemplate(
        { subject: 'Hi {member.name}', body: 'Hello **{member.name}**, [open]({link})' },
        {
          'member.name': '<img src=x onerror=alert(1)> [evil](https://evil.example)\r\nBcc: x@example.com',
          link: 'javascript:alert(1)',
          'site.name': 'Acme',
        },
      )
      expect(rendered.html).not.toContain('<img')
      expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
      expect(rendered.html).not.toContain('href="https://evil.example"')
      expect(rendered.html).not.toContain('javascript:')
      expect(rendered.html).toContain('href="#"')
      expect(rendered.subject).not.toMatch(/[\r\n]/)
    })

    it('never lets a template carry a variable to another address', () => {
      const secret = 'https://example.com/reset?token=SINGLE-USE'
      const rendered = renderMailTemplate(
        {
          subject: 'S',
          body: [
            '[wrapped](https://evil.example/?t={link})',
            '![pixel](https://evil.example/p.gif?t={link})',
            '[prefixed](https://evil.example/{link})',
            '[whole]({link})',
          ].join('\n\n'),
        },
        { link: secret },
      )
      // Only the address that IS the variable gets the value.
      expect(rendered.html.match(/token=SINGLE-USE/g)).toHaveLength(1)
      expect(rendered.html).toContain(`href="${secret}"`)
      expect(rendered.html).not.toContain('evil.example/?t=https')
      expect(rendered.html).not.toMatch(/src="[^"]*SINGLE-USE/)
    })

    it('keeps a real link working and leaves unknown variables visible', () => {
      const rendered = renderMailTemplate(
        { subject: 'S', body: '[Confirm]({link}) {not.a.variable}' },
        { link: 'https://example.com/confirm?token=abc&x=1' },
      )
      expect(rendered.html).toContain('href="https://example.com/confirm?token=abc&amp;x=1"')
      expect(rendered.html).toContain('{not.a.variable}')
      expect(rendered.text).toContain('https://example.com/confirm?token=abc&x=1')
      expect(unknownMailVariables('{link} {nope}', [{ name: 'link', label: 'Link', sample: '' }])).toEqual(['nope'])
    })

    it('sends the built-in wording until an owner edits it, then the edit, then the built-in again', async () => {
      const env = { NODE_ENV: 'development' }
      const send = () => queueTemplateMail(
        h.db,
        { key: 'test.welcome', to: MESSAGE.to, variables: { 'member.name': 'Grace', link: 'https://example.com/c' } },
        { env },
      )
      await send()
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        kind: 'test.welcome',
        subject: 'Welcome to Capability Matrix, Grace',
      })

      const put = await h.cms('/admin/api/cms/mail/templates/test.welcome', {
        method: 'PUT', cookie: owner, json: { subject: 'Hey {member.name}', body: 'Custom body for {member.name}' },
      })
      expect((await readJson<{ template: MailTemplate }>(put)).template.customised).toBe(true)
      await send()
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ subject: 'Hey Grace', body: 'Custom body for Grace' })

      const reset = await h.cms('/admin/api/cms/mail/templates/test.welcome', { method: 'DELETE', cookie: owner })
      expect((await readJson<{ template: MailTemplate }>(reset)).template).toMatchObject({
        customised: false,
        subject: 'Welcome to {site.name}, {member.name}',
      })
    })

    it('previews the site variables with the real site name, and the rest with samples', async () => {
      const res = await h.cms('/admin/api/cms/mail/templates', { cookie: owner })
      const { templates } = await readJson<{ templates: MailTemplate[] }>(res)
      const variables = templates.find((template) => template.key === 'test.welcome')?.variables ?? []
      const sample = (name: string) => variables.find((variable) => variable.name === name)?.sample
      expect(sample('site.name')).toBe('Capability Matrix')
      expect(sample('member.name')).toBe('Ada')
    })

    it('refuses to save a template that is not in the catalogue, or an empty one', async () => {
      const unknown = await h.cms('/admin/api/cms/mail/templates/nope', {
        method: 'PUT', cookie: owner, json: { subject: 'S', body: 'B' },
      })
      expect(unknown.status).toBe(404)
      const empty = await h.cms('/admin/api/cms/mail/templates/test.welcome', {
        method: 'PUT', cookie: owner, json: { subject: '', body: 'B' },
      })
      expect(empty.status).toBe(400)
    })

    it('sends a template test with sample values, never real ones', async () => {
      const res = await h.cms('/admin/api/cms/mail/templates/test.welcome/test', {
        method: 'POST', cookie: owner, json: { to: MESSAGE.to },
      })
      expect((await readJson<{ status: string }>(res)).status).toBe('captured')
      expect((await listMailActivity(h.db)).entries[0].body).toContain('https://example.com/confirm?token=sample')
    })
  })

  describe('SMTP address guard', () => {
    const answers = (...addresses: string[]) => async () => addresses.map((address) => ({ address }))

    it('rejects a host with any private answer, even beside a public one', async () => {
      await expect(resolveSmtpAddress('mail.example.com', false, answers('8.8.8.8', '127.0.0.1')))
        .rejects.toBeInstanceOf(MailDeliveryError)
      await expect(resolveSmtpAddress('mail.example.com', false, answers('169.254.169.254')))
        .rejects.toBeInstanceOf(MailDeliveryError)
    })

    it('rejects an IP literal unless private hosts are allowed', async () => {
      await expect(resolveSmtpAddress('127.0.0.1', false)).rejects.toBeInstanceOf(MailDeliveryError)
      expect(await resolveSmtpAddress('127.0.0.1', true)).toBe('127.0.0.1')
    })

    it('pins to a public IPv4 answer and allows private answers only when opted in', async () => {
      expect(await resolveSmtpAddress('mail.example.com', false, answers('2606:4700:4700::1111', '8.8.8.8')))
        .toBe('8.8.8.8')
      expect(await resolveSmtpAddress('mailpit', true, answers('10.0.0.5'))).toBe('10.0.0.5')
    })

    it('quotes the sender name so it cannot break out of the From header', () => {
      expect(formatFromHeader('', 'a@example.com')).toBe('a@example.com')
      expect(formatFromHeader('Ex "Quoted" \\ Co', 'a@example.com')).toBe('"Ex \\"Quoted\\" \\\\ Co" <a@example.com>')
    })
  })

  describe('Amazon SES', () => {
    it('signs a request exactly as AWS documents (Signature Version 4 example)', () => {
      const authorization = signAwsRequest({
        method: 'GET',
        host: 'iam.amazonaws.com',
        path: '/',
        query: 'Action=ListUsers&Version=2010-05-08',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: '',
        region: 'us-east-1',
        service: 'iam',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        amzDate: '20150830T123600Z',
      })
      expect(authorization).toBe(
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
          'SignedHeaders=content-type;host;x-amz-date, ' +
          'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
      )
    })

    it('posts one signed SendEmail call to the region’s own host', async () => {
      const calls: Array<{ url: string; init: RequestInit }> = []
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response('{"MessageId":"abc"}', { status: 200 })
      }) as typeof fetch
      const messageId = await sendViaSes(
        SES.config,
        SES.secret,
        { fromAddress: 'hello@example.com', fromHeader: '"Example" <hello@example.com>', replyTo: 'help@example.com' },
        { to: 'reader@example.com', subject: 'Hello', text: 'Text', html: '<p>Html</p>' },
        { fetchImpl, now: () => new Date('2026-01-02T03:04:05.678Z') },
      )
      expect(messageId).toBe('abc')
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails')
      const headers = new Headers(calls[0].init.headers)
      expect(headers.get('x-amz-date')).toBe('20260102T030405Z')
      expect(headers.get('authorization')).toContain('Credential=AKIAIOSFODNN7EXAMPLE/20260102/eu-central-1/ses/aws4_request')
      expect(headers.get('authorization')).not.toContain(SES.secret)
      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        FromEmailAddress: '"Example" <hello@example.com>',
        Destination: { ToAddresses: ['reader@example.com'] },
        ReplyToAddresses: ['help@example.com'],
      })
    })

    it('turns a refusal into a safe sentence, never AWS’s own text or the key', async () => {
      const fetchImpl = (async () =>
        new Response('{"message":"The security token included in the request is invalid: ses-secret-value"}', { status: 403 })
      ) as unknown as typeof fetch
      const failure = await sendViaSes(
        SES.config, SES.secret,
        { fromAddress: 'a@example.com', fromHeader: 'a@example.com', replyTo: '' },
        { to: 'r@example.com', subject: 'S', text: 'T' },
        { fetchImpl },
      ).catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(MailDeliveryError)
      expect((failure as Error).message).toBe('Amazon SES rejected the access key or its permissions.')
    })
  })

  describe('one-key providers', () => {
    const sender = { fromAddress: 'hello@example.com', fromName: 'Example', fromHeader: '"Example" <hello@example.com>', replyTo: 'help@example.com' }
    const mail = { to: 'reader@example.com', subject: 'Hello', text: 'Text', html: '<p>Html</p>' }
    const KEY = 'key-that-must-never-leak'

    function recorder(answer: string, status = 200) {
      const calls: Array<{ url: string; headers: Headers; body: string }> = []
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) })
        return new Response(answer, { status })
      }) as typeof fetch
      return { calls, fetchImpl }
    }

    it('sends through Resend with a bearer key', async () => {
      const { calls, fetchImpl } = recorder('{"id":"re_1"}')
      expect(await sendViaResend(KEY, sender, mail, { fetchImpl })).toBe('re_1')
      expect(calls[0].url).toBe('https://api.resend.com/emails')
      expect(calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`)
      expect(JSON.parse(calls[0].body)).toEqual({
        from: '"Example" <hello@example.com>', to: ['reader@example.com'], subject: 'Hello',
        text: 'Text', html: '<p>Html</p>', reply_to: 'help@example.com',
      })
    })

    it('sends through Postmark on its transactional stream', async () => {
      const { calls, fetchImpl } = recorder('{"MessageID":"pm_1","ErrorCode":0}')
      expect(await sendViaPostmark(KEY, sender, mail, { fetchImpl })).toBe('pm_1')
      expect(calls[0].url).toBe('https://api.postmarkapp.com/email')
      expect(calls[0].headers.get('x-postmark-server-token')).toBe(KEY)
      expect(JSON.parse(calls[0].body)).toMatchObject({
        From: '"Example" <hello@example.com>', To: 'reader@example.com', Subject: 'Hello',
        TextBody: 'Text', HtmlBody: '<p>Html</p>', ReplyTo: 'help@example.com', MessageStream: 'outbound',
      })
    })

    it('sends through Mailgun on the region’s host, with the domain only as a path part', async () => {
      const { calls, fetchImpl } = recorder('{"id":"<mg_1@mg.example.com>","message":"Queued"}')
      const id = await sendViaMailgun({ domain: 'MG.example.com', region: 'eu' }, KEY, sender, mail, { fetchImpl })
      expect(id).toBe('mg_1@mg.example.com')
      expect(calls[0].url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages')
      expect(calls[0].headers.get('authorization')).toBe(`Basic ${Buffer.from(`api:${KEY}`).toString('base64')}`)
      const form = new URLSearchParams(calls[0].body)
      expect(Object.fromEntries(form)).toEqual({
        from: '"Example" <hello@example.com>', to: 'reader@example.com', subject: 'Hello',
        text: 'Text', html: '<p>Html</p>', 'h:Reply-To': 'help@example.com',
      })
      const us = recorder('{}')
      await sendViaMailgun({ domain: 'mg.example.com', region: 'us' }, KEY, sender, mail, { fetchImpl: us.fetchImpl })
      expect(us.calls[0].url).toBe('https://api.mailgun.net/v3/mg.example.com/messages')
    })

    it('sends through Brevo with the sender as an address and a name', async () => {
      const { calls, fetchImpl } = recorder('{"messageId":"<br_1@smtp-relay.mailin.fr>"}')
      expect(await sendViaBrevo(KEY, sender, mail, { fetchImpl })).toBe('br_1@smtp-relay.mailin.fr')
      expect(calls[0].url).toBe('https://api.brevo.com/v3/smtp/email')
      expect(calls[0].headers.get('api-key')).toBe(KEY)
      expect(JSON.parse(calls[0].body)).toEqual({
        sender: { email: 'hello@example.com', name: 'Example' }, to: [{ email: 'reader@example.com' }],
        subject: 'Hello', textContent: 'Text', htmlContent: '<p>Html</p>', replyTo: { email: 'help@example.com' },
      })
    })

    it('reports a refusal in a sentence, with the provider’s short reason and never the key', async () => {
      const refused = recorder('{"message":"The example.com domain is not verified."}', 403)
      const failure = await sendViaResend(KEY, sender, mail, { fetchImpl: refused.fetchImpl }).catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(MailDeliveryError)
      expect((failure as Error).message).toBe('Resend rejected the API key or its permissions. The example.com domain is not verified.')
      expect((failure as Error).message).not.toContain(KEY)

      // A long or unreadable answer is dropped; the status alone decides the sentence.
      const noisy = recorder(`{"Message":"${'x'.repeat(400)}"}`, 422)
      expect(((await sendViaPostmark(KEY, sender, mail, { fetchImpl: noisy.fetchImpl }).catch((err: unknown) => err)) as Error).message)
        .toBe('Postmark refused the message (HTTP 422).')
      const down = recorder('<html>gateway</html>', 502)
      expect(((await sendViaBrevo(KEY, sender, mail, { fetchImpl: down.fetchImpl }).catch((err: unknown) => err)) as Error).message)
        .toBe('Brevo is having trouble right now (HTTP 502). Try again shortly.')
    })

    it('reports an unreachable provider without the cause’s text', async () => {
      const fetchImpl = (async () => { throw new Error(`connect failed with ${KEY}`) }) as unknown as typeof fetch
      const failure = await sendViaMailgun({ domain: 'mg.example.com', region: 'us' }, KEY, sender, mail, { fetchImpl }).catch((err: unknown) => err)
      expect((failure as Error).message).toBe('Could not reach Mailgun. Check the server\'s network.')
    })

    it('stores a one-key connector and refuses a malformed one', async () => {
      const userId = await ownerUserId()
      const made = await createMailConnector(h.db, { kind: 'mailgun', label: 'Mailgun', config: { domain: 'MG.Example.com', region: 'eu' }, secret: KEY }, userId)
      expect(made).toMatchObject({ kind: 'mailgun', hasSecret: true, config: { domain: 'mg.example.com', region: 'eu' } })
      expect(await resolveConnector(h.db, made.id)).toMatchObject({ kind: 'mailgun', secret: KEY })
      const resend = await createMailConnector(h.db, { kind: 'resend', label: 'Resend', config: {}, secret: KEY }, userId)
      expect((await listMailConnectors(h.db)).map((connector) => connector.kind).sort()).toEqual(['mailgun', 'resend'])
      expect(JSON.stringify(await getMailConnector(h.db, resend.id))).not.toContain(KEY)

      for (const bad of [
        { kind: 'resend', label: 'R', config: {}, secret: '' },
        { kind: 'resend', label: 'R', config: { host: 'evil.example.com' }, secret: KEY },
        { kind: 'postmark', label: 'P', config: {}, secret: 'a\r\nx-evil: 1' },
        { kind: 'mailgun', label: 'M', config: { domain: 'mg.example.com/../v4', region: 'us' }, secret: KEY },
        { kind: 'mailgun', label: 'M', config: { domain: 'mg.example.com', region: 'asia' }, secret: KEY },
      ]) {
        expect(safeParseValue(MailConnectorInputSchema, bad).ok).toBe(false)
      }
    })
  })

  describe('admin API', () => {
    it('is closed to a user without mail.manage', async () => {
      const editor = await h.createRoleUser({ name: 'Editor', slug: 'editor', capabilities: ['site.read'] })
      for (const [method, path, json] of [
        ['GET', '/admin/api/cms/mail', undefined],
        ['GET', '/admin/api/cms/mail/templates', undefined],
        ['GET', '/admin/api/cms/mail/activity', undefined],
        ['POST', '/admin/api/cms/mail/connectors', SMTP],
        ['PUT', '/admin/api/cms/mail/defaults', { defaultConnectorId: null, fromAddress: '', fromName: '', replyTo: '' }],
        ['PUT', '/admin/api/cms/mail/templates/test.welcome', { subject: 'S', body: 'B' }],
      ] as const) {
        await expectForbidden(await h.cms(path, { method, cookie: editor.cookie, ...(json ? { json } : {}) }))
      }
    })

    it('asks for step-up before adding or removing a connector or changing the defaults', async () => {
      const { cookie } = await h.createRoleUser({ name: 'Mailer', slug: 'mailer', capabilities: ['mail.manage'] })
      const edit = await h.cms('/admin/api/cms/mail/templates/test.welcome', {
        method: 'PUT', cookie, json: { subject: 'S', body: 'B' },
      })
      expect(edit.status).toBe(401)
      expect((await h.cms('/admin/api/cms/mail/templates/test.welcome', { method: 'DELETE', cookie })).status).toBe(401)
      const add = await h.cms('/admin/api/cms/mail/connectors', { method: 'POST', cookie, json: SMTP })
      expect(add.status).toBe(401)
      expect((await readJson<{ error: string }>(add)).error).toBe('step_up_required')
      const defaults = await h.cms('/admin/api/cms/mail/defaults', {
        method: 'PUT', cookie, json: { defaultConnectorId: null, fromAddress: '', fromName: '', replyTo: '' },
      })
      expect(defaults.status).toBe(401)
      expect((await h.cms('/admin/api/cms/mail/connectors/x', { method: 'DELETE', cookie })).status).toBe(401)
    })

    it('adds a connector, makes the first one the default, never returns its secret, and audits it', async () => {
      const res = await h.cms('/admin/api/cms/mail/connectors', { method: 'POST', cookie: owner, json: SMTP })
      expect(res.status).toBe(201)
      const raw = await res.text()
      expect(raw).not.toContain(SMTP.secret)
      const { connector } = JSON.parse(raw) as { connector: MailConnector }
      expect(connector).toMatchObject({ kind: 'smtp', hasSecret: true, secretNeedsReentry: false })

      const overviewRes = await h.cms('/admin/api/cms/mail', { cookie: owner })
      const overviewRaw = await overviewRes.text()
      expect(overviewRaw).not.toContain(SMTP.secret)
      const { overview } = JSON.parse(overviewRaw) as { overview: MailOverview }
      expect(overview.defaults.defaultConnectorId).toBe(connector.id)
      // A connector alone is not enough: there is no sender address yet.
      expect(overview.mode).toBe('capture')

      const audit = await readJson<{ events: Array<{ action: string }> }>(await h.cms('/admin/api/cms/audit', { cookie: owner }))
      expect(audit.events.some((event) => event.action === 'mail.connector.create')).toBe(true)

      const removed = await h.cms(`/admin/api/cms/mail/connectors/${connector.id}`, { method: 'DELETE', cookie: owner })
      const after = (await readJson<{ overview: MailOverview }>(removed)).overview
      expect(after.connectors).toEqual([])
      expect(after.defaults.defaultConnectorId).toBeNull()
    })

    it('rejects malformed connectors and defaults', async () => {
      for (const bad of [
        { ...SMTP, config: { ...SMTP.config, host: 'smtp.example.com/evil' } },
        { ...SMTP, config: { ...SMTP.config, port: 0 } },
        { ...SMTP, label: 'A\r\nB' },
        { ...SES, config: { ...SES.config, region: 'evil.example.com/' } },
        { ...SES, secret: '' },
        { ...SMTP, kind: 'sendmail' },
      ]) {
        const res = await h.cms('/admin/api/cms/mail/connectors', { method: 'POST', cookie: owner, json: bad })
        expect(res.status).toBe(400)
      }
      for (const bad of [
        { defaultConnectorId: null, fromAddress: 'not-an-address', fromName: '', replyTo: '' },
        { defaultConnectorId: null, fromAddress: '', fromName: 'A\r\nBcc: x@example.com', replyTo: '' },
        { defaultConnectorId: 'no-such-connector', fromAddress: '', fromName: '', replyTo: '' },
      ]) {
        const res = await h.cms('/admin/api/cms/mail/defaults', { method: 'PUT', cookie: owner, json: bad })
        expect(res.status).toBe(400)
      }
    })

    it('needs a sender address before a connector can be tested', async () => {
      const created = await h.cms('/admin/api/cms/mail/connectors', { method: 'POST', cookie: owner, json: SMTP })
      const { connector } = await readJson<{ connector: MailConnector }>(created)
      const res = await h.cms(`/admin/api/cms/mail/connectors/${connector.id}/test`, {
        method: 'POST', cookie: owner, json: { to: MESSAGE.to },
      })
      expect(res.status).toBe(422)
      expect((await readJson<{ error: string }>(res)).error).toContain('sender address')
    })

    it('narrows the list by search, template and connector while the totals keep describing the period', async () => {
      await recordMail(h.db, { kind: 'test.welcome', to: 'ada@example.com', subject: 'Welcome Ada', status: 'sent', connector: { id: 'c1', label: 'Main relay' } })
      await recordMail(h.db, { kind: 'test', to: 'bob@example.com', subject: 'Test email', status: 'failed', connector: { id: 'c2', label: 'Backup' }, error: 'Rejected' })
      await recordMail(h.db, { kind: 'test.welcome', to: 'cy@example.com', subject: 'Welcome Cy', status: 'captured', body: 'Hi Cy' })

      const read = async (query: string) =>
        readJson<MailActivityResponse>(await h.cms(`/admin/api/cms/mail/activity?${query}`, { cookie: owner }))

      const searched = await read('q=ADA')
      expect(searched.entries.map((entry) => entry.to)).toEqual(['ada@example.com'])
      expect(searched.matching).toBe(1)
      expect(searched.totals).toEqual({ queued: 0, sent: 1, failed: 1, captured: 1 })
      expect(searched.lastFailure?.error).toBe('Rejected')

      const welcome = await read('kind=test.welcome')
      expect(welcome.entries.map((entry) => entry.to)).toEqual(['cy@example.com', 'ada@example.com'])
      expect(welcome.entries[0]).toMatchObject({ kindLabel: 'Welcome', template: true, body: 'Hi Cy' })
      expect(welcome.kinds).toEqual([
        { value: 'test.welcome', label: 'Welcome', count: 2 },
        { value: 'test', label: 'Connector test', count: 1 },
      ])

      const backup = await read('connector=Backup')
      expect(backup.entries.map((entry) => entry.to)).toEqual(['bob@example.com'])
      expect(backup.entries[0]).toMatchObject({ kindLabel: 'Connector test', template: false })
      expect(backup.connectors.map((facet) => facet.value).sort()).toEqual(['Backup', 'Main relay'])
    })

    it('reads the log a page at a time', async () => {
      for (let index = 0; index < 5; index += 1) {
        await recordMail(h.db, { kind: 'test', to: `r${index}@example.com`, subject: `S${index}`, status: 'sent' })
      }
      const first = await listMailActivity(h.db, { limit: 2 })
      expect(first.entries.map((entry) => entry.subject)).toEqual(['S4', 'S3'])
      expect(first.matching).toBe(5)
      const second = await listMailActivity(h.db, { limit: 2, before: first.nextCursor ?? undefined })
      expect(second.entries.map((entry) => entry.subject)).toEqual(['S2', 'S1'])
      const last = await listMailActivity(h.db, { limit: 2, before: second.nextCursor ?? undefined })
      expect(last.entries.map((entry) => entry.subject)).toEqual(['S0'])
      expect(last.nextCursor).toBeNull()
    })

    it('buckets a period into the viewer\'s calendar days and leaves older mail out of it', async () => {
      const now = Date.parse('2026-03-10T23:30:00Z') // already 11 March in Prague
      const at = async (iso: string, status: 'sent' | 'failed') => {
        await recordMail(h.db, { kind: 'test', to: 'r@example.com', subject: iso, status })
        await h.db`update mail_outbox set created_at = ${iso} where subject = ${iso}`
      }
      await at('2026-03-10T23:10:00Z', 'sent')
      await at('2026-03-10T12:00:00Z', 'failed')
      await at('2026-03-01T12:00:00Z', 'sent')

      const week = await listMailActivity(h.db, { period: '7d', timeZone: 'Europe/Prague' }, now)
      expect(week.buckets.map((bucket) => bucket.start)).toEqual([
        '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11',
      ])
      expect(week.buckets[5]).toMatchObject({ sent: 0, failed: 1 })
      expect(week.buckets[6]).toMatchObject({ sent: 1, failed: 0 })
      expect(week.totals).toEqual({ queued: 0, sent: 1, failed: 1, captured: 0 })
      expect(week.matching).toBe(2)

      const day = await listMailActivity(h.db, { period: '24h', timeZone: 'not/a-zone' }, now)
      expect(day.buckets).toHaveLength(24)
      expect(day.totals).toEqual({ queued: 0, sent: 1, failed: 1, captured: 0 })
    })

    it('filters the activity by status', async () => {
      await sendSiteMail(h.db, MESSAGE, { env: { NODE_ENV: 'development' } })
      const captured = await readJson<MailActivityResponse>(
        await h.cms('/admin/api/cms/mail/activity?status=captured', { cookie: owner }),
      )
      expect(captured.entries).toHaveLength(1)
      const sent = await readJson<MailActivityResponse>(
        await h.cms('/admin/api/cms/mail/activity?status=sent', { cookie: owner }),
      )
      expect(sent.entries).toEqual([])
      expect(sent.totals.captured).toBe(1)
    })
  })
})
