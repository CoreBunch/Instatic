import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  expectForbidden,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import type { MailOutboxEntry, MailSettingsView } from '@core/mail'
import { listMailOutbox } from '../../../server/mail/outbox'
import { MailNotConfiguredError, sendSiteMail } from '../../../server/mail/send'
import { resolveMailAccount, saveMailSettings } from '../../../server/mail/settings'
import {
  formatFromHeader,
  MailDeliveryError,
  resolveSmtpAddress,
  type OutgoingMail,
} from '../../../server/mail/transport'
import type { ResolvedMailAccount } from '../../../server/mail/settings'

const ACCOUNT = {
  host: 'SMTP.Example.com',
  port: 587,
  username: 'mailer',
  password: 'smtp-secret-value',
  fromAddress: 'hello@example.com',
  fromName: 'Example',
}

const MESSAGE = {
  kind: 'test',
  to: 'reader@example.com',
  subject: 'Hello',
  text: 'Body with a secret link https://example.com/reset?token=abc',
}

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

  describe('delivery', () => {
    it('captures the message with its body on a development server with no account', async () => {
      const status = await sendSiteMail(h.db, MESSAGE, { env: { NODE_ENV: 'development' } })
      expect(status).toBe('captured')
      const [entry] = await listMailOutbox(h.db)
      expect(entry).toMatchObject({ status: 'captured', to: MESSAGE.to, body: MESSAGE.text })
    })

    it('refuses on a production server with no account and records nothing', async () => {
      await expect(
        sendSiteMail(h.db, MESSAGE, { env: { NODE_ENV: 'production' } }),
      ).rejects.toBeInstanceOf(MailNotConfiguredError)
      expect(await listMailOutbox(h.db)).toEqual([])
    })

    it('sends through the saved account and never stores the body', async () => {
      await saveMailSettings(h.db, ACCOUNT, await ownerUserId())
      const seen: Array<{ account: ResolvedMailAccount; mail: OutgoingMail }> = []
      const status = await sendSiteMail(h.db, MESSAGE, {
        smtp: async (account, mail) => { seen.push({ account, mail }) },
      })
      expect(status).toBe('sent')
      expect(seen[0].account).toMatchObject({ host: 'smtp.example.com', password: ACCOUNT.password })
      const [entry] = await listMailOutbox(h.db)
      expect(entry).toMatchObject({ status: 'sent', body: null, error: null })
    })

    it('logs a failed delivery without the body and rethrows', async () => {
      await saveMailSettings(h.db, ACCOUNT, await ownerUserId())
      await expect(
        sendSiteMail(h.db, MESSAGE, {
          smtp: async () => { throw new MailDeliveryError('The SMTP server rejected the username or password.') },
        }),
      ).rejects.toBeInstanceOf(MailDeliveryError)
      const [entry] = await listMailOutbox(h.db)
      expect(entry).toMatchObject({
        status: 'failed',
        body: null,
        error: 'The SMTP server rejected the username or password.',
      })
    })

    it('rejects a recipient or subject that could add headers', async () => {
      const env = { NODE_ENV: 'development' }
      await expect(
        sendSiteMail(h.db, { ...MESSAGE, subject: 'Hi\r\nBcc: attacker@example.com' }, { env }),
      ).rejects.toBeInstanceOf(MailDeliveryError)
      await expect(
        sendSiteMail(h.db, { ...MESSAGE, to: 'reader@example.com\nBcc: attacker@example.com' }, { env }),
      ).rejects.toBeInstanceOf(MailDeliveryError)
      expect(await listMailOutbox(h.db)).toEqual([])
    })
  })

  describe('account storage', () => {
    it('stores the password encrypted and keeps it when a save omits it', async () => {
      const userId = await ownerUserId()
      await saveMailSettings(h.db, ACCOUNT, userId)
      const { rows } = await h.db<{ password_ciphertext: Uint8Array }>`
        select password_ciphertext from mail_settings
      `
      expect(Buffer.from(rows[0].password_ciphertext).toString('utf8')).not.toContain(ACCOUNT.password)

      const { password: _omitted, ...withoutPassword } = ACCOUNT
      await saveMailSettings(h.db, { ...withoutPassword, port: 465 }, userId)
      expect(await resolveMailAccount(h.db)).toMatchObject({ port: 465, password: ACCOUNT.password })

      await saveMailSettings(h.db, { ...ACCOUNT, password: '' }, userId)
      expect((await resolveMailAccount(h.db))?.password).toBe('')
    })
  })

  describe('SMTP address guard', () => {
    const answers = (...addresses: string[]) => async () => addresses.map((address) => ({ address }))

    it('rejects a host with any private answer, even beside a public one', async () => {
      await expect(
        resolveSmtpAddress('mail.example.com', false, answers('8.8.8.8', '127.0.0.1')),
      ).rejects.toBeInstanceOf(MailDeliveryError)
      await expect(
        resolveSmtpAddress('mail.example.com', false, answers('169.254.169.254')),
      ).rejects.toBeInstanceOf(MailDeliveryError)
    })

    it('rejects an IP literal unless private hosts are allowed', async () => {
      await expect(resolveSmtpAddress('127.0.0.1', false)).rejects.toBeInstanceOf(MailDeliveryError)
      expect(await resolveSmtpAddress('127.0.0.1', true)).toBe('127.0.0.1')
    })

    it('pins to a public IPv4 answer and allows private answers only when opted in', async () => {
      expect(
        await resolveSmtpAddress('mail.example.com', false, answers('2606:4700:4700::1111', '8.8.8.8')),
      ).toBe('8.8.8.8')
      expect(await resolveSmtpAddress('mailpit', true, answers('10.0.0.5'))).toBe('10.0.0.5')
    })

    it('quotes the sender name so it cannot break out of the From header', () => {
      expect(formatFromHeader('', 'a@example.com')).toBe('a@example.com')
      expect(formatFromHeader('Ex "Quoted" \\ Co', 'a@example.com'))
        .toBe('"Ex \\"Quoted\\" \\\\ Co" <a@example.com>')
    })
  })

  describe('admin API', () => {
    it('is closed to a user without mail.manage', async () => {
      const editor = await h.createRoleUser({ name: 'Editor', slug: 'editor', capabilities: ['site.read'] })
      await expectForbidden(await h.cms('/admin/api/cms/mail/settings', { cookie: editor.cookie }))
      await expectForbidden(await h.cms('/admin/api/cms/mail/outbox', { cookie: editor.cookie }))
      await expectForbidden(
        await h.cms('/admin/api/cms/mail/settings', { method: 'PUT', cookie: editor.cookie, json: ACCOUNT }),
      )
      await expectForbidden(
        await h.cms('/admin/api/cms/mail/test', { method: 'POST', cookie: editor.cookie, json: { to: MESSAGE.to } }),
      )
    })

    it('asks for step-up before saving or removing the account', async () => {
      const { cookie: fresh } = await h.createRoleUser({
        name: 'Mailer',
        slug: 'mailer',
        capabilities: ['mail.manage'],
      })
      const save = await h.cms('/admin/api/cms/mail/settings', { method: 'PUT', cookie: fresh, json: ACCOUNT })
      expect(save.status).toBe(401)
      expect((await readJson<{ error: string }>(save)).error).toBe('step_up_required')
      const remove = await h.cms('/admin/api/cms/mail/settings', { method: 'DELETE', cookie: fresh })
      expect(remove.status).toBe(401)
    })

    it('saves the account, never returns the password, and audits the change', async () => {
      const res = await h.cms('/admin/api/cms/mail/settings', { method: 'PUT', cookie: owner, json: ACCOUNT })
      expect(res.status).toBe(200)
      const raw = await res.text()
      expect(raw).not.toContain(ACCOUNT.password)
      const { settings } = JSON.parse(raw) as { settings: MailSettingsView }
      expect(settings.mode).toBe('smtp')
      expect(settings.account).toMatchObject({
        host: 'smtp.example.com',
        hasPassword: true,
        passwordNeedsReentry: false,
      })

      const audit = await h.cms('/admin/api/cms/audit', { cookie: owner })
      const { events } = await readJson<{ events: Array<{ action: string }> }>(audit)
      expect(events.some((event) => event.action === 'mail.settings.update')).toBe(true)

      const removed = await h.cms('/admin/api/cms/mail/settings', { method: 'DELETE', cookie: owner })
      expect((await readJson<{ settings: MailSettingsView }>(removed)).settings.account).toBeNull()
    })

    it('rejects a malformed account', async () => {
      for (const bad of [
        { ...ACCOUNT, host: 'smtp.example.com/evil' },
        { ...ACCOUNT, port: 0 },
        { ...ACCOUNT, fromAddress: 'not-an-address' },
        { ...ACCOUNT, fromName: 'A\r\nBcc: x@example.com' },
        { ...ACCOUNT, extra: true },
      ]) {
        const res = await h.cms('/admin/api/cms/mail/settings', { method: 'PUT', cookie: owner, json: bad })
        expect(res.status).toBe(400)
      }
    })

    it('captures a test email on a development server and lists it', async () => {
      const res = await h.cms('/admin/api/cms/mail/test', { method: 'POST', cookie: owner, json: { to: MESSAGE.to } })
      expect(res.status).toBe(200)
      expect((await readJson<{ status: string }>(res)).status).toBe('captured')
      const log = await h.cms('/admin/api/cms/mail/outbox', { cookie: owner })
      const { entries } = await readJson<{ entries: MailOutboxEntry[] }>(log)
      expect(entries[0]).toMatchObject({ kind: 'test', to: MESSAGE.to, status: 'captured' })
    })
  })
})
