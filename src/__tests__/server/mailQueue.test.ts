import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { registerMailTemplate, type MailConnector } from '@core/mail'
import { listMailActivity } from '../../../server/mail/activity'
import {
  createMailConnector,
  getMailConnector,
  noteConnectorUse,
  setMailConnectorSecret,
} from '../../../server/mail/connectors'
import { saveMailDefaults } from '../../../server/mail/defaults'
import type { DbClient } from '../../../server/db/client'
import {
  __resetMailQueuePauseForTesting,
  drainMailQueue,
  mailRetryDelayMs,
  queueTemplateMail,
} from '../../../server/mail/delivery'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'
import { MailNotConfiguredError, type MailCarrier } from '../../../server/mail/send'
import { sendViaResend } from '../../../server/mail/apiDrivers'
import { sendViaSes } from '../../../server/mail/sesDriver'
import { MailDeliveryError, retryForHttpStatus, retryForSmtpFailure } from '../../../server/mail/smtpDriver'
import { flushMemberMail, queueMemberMail } from '../../../server/members/mail'

const SMTP = {
  kind: 'smtp' as const,
  label: 'Main relay',
  config: { host: 'smtp.example.com', port: 587, username: 'mailer' },
  secret: 'smtp-secret-value',
}
const LINK = 'https://example.com/confirm?token=live-secret-token'
const MAIL = { key: 'queue.welcome', to: 'reader@example.com', variables: { link: LINK } }
const MINUTE = 60_000
const HOUR = 60 * MINUTE

registerMailTemplate({
  key: 'queue.welcome',
  label: 'Queue welcome',
  description: 'Test fixture.',
  group: 'Test',
  variables: [{ name: 'link', label: 'Link', sample: 'https://example.com/confirm?token=sample' }],
  defaultSubject: 'Welcome',
  defaultBody: '[Confirm]({link})',
})

describe('mail queue', () => {
  let h: CapabilityTestHarness
  let now = 0
  const clock = () => now

  beforeEach(async () => {
    h = await createCapabilityTestHarness()
    await h.setupOwner()
    // The test clock runs a little ahead of the real one, so an email queued
    // "now" (by the real clock) is already due.
    now = Date.now() + 5_000
    __resetMailQueuePauseForTesting()
  })

  afterEach(async () => {
    await h.cleanup()
  })

  async function readyConnector(): Promise<MailConnector> {
    const { rows } = await h.db<{ id: string }>`select id from users limit 1`
    const connector = await createMailConnector(h.db, SMTP, rows[0].id)
    await saveMailDefaults(
      h.db,
      { defaultConnectorId: connector.id, fromAddress: 'hello@example.com', fromName: 'Example', replyTo: '' },
      rows[0].id,
    )
    return connector
  }

  async function queueRows() {
    const { rows } = await h.db<{
      id: string
      attempts: number
      next_attempt_at: string | Date
      claimed_at: string | Date | null
      lane: number
      payload_ciphertext: Uint8Array
    }>`select id, attempts, next_attempt_at, claimed_at, lane, payload_ciphertext from mail_queue order by created_at, id`
    return rows
  }

  const drain = (carrier: MailCarrier) =>
    drainMailQueue(h.db, { carrier, now: clock, random: () => 0.5, paceMs: 0 })

  describe('accepting an email', () => {
    it('captures on a development server with nothing set up and queues nothing', async () => {
      expect(await queueTemplateMail(h.db, MAIL, { env: { NODE_ENV: 'development' } })).toBe('captured')
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'captured', attempts: 0 })
    })

    it('refuses in production with nothing set up', async () => {
      await expect(queueTemplateMail(h.db, MAIL, { env: { NODE_ENV: 'production' } }))
        .rejects.toBeInstanceOf(MailNotConfiguredError)
      expect(await queueRows()).toHaveLength(0)
    })

    it('refuses an unknown template and a recipient that could add headers before queueing', async () => {
      await readyConnector()
      await expect(queueTemplateMail(h.db, { ...MAIL, key: 'nope' })).rejects.toThrow('unknown mail template')
      await expect(queueTemplateMail(h.db, { ...MAIL, to: 'a@example.com\nBcc: x@example.com' }))
        .rejects.toBeInstanceOf(MailDeliveryError)
      expect(await queueRows()).toHaveLength(0)
    })

    it('stores the values encrypted and logs the email as waiting', async () => {
      await readyConnector()
      expect(await queueTemplateMail(h.db, MAIL)).toBe('queued')
      const [row] = await queueRows()
      expect(row.lane).toBe(0)
      const stored = Buffer.from(row.payload_ciphertext).toString('latin1')
      expect(stored).not.toContain('live-secret-token')
      expect(stored).not.toContain('example.com')
      const { entries, totals } = await listMailActivity(h.db)
      expect(entries[0]).toMatchObject({ status: 'queued', attempts: 0, subject: 'Welcome', body: null })
      expect(totals).toEqual({ queued: 1, sent: 0, failed: 0, captured: 0 })
    })
  })

  describe('delivering', () => {
    it('sends the email, with its values, and leaves nothing of it in the queue', async () => {
      const connector = await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      const carried: string[] = []
      await drain(async (_connector, _sender, mail) => {
        carried.push(`${mail.to} ${mail.text}`)
        return 'provider-id-1'
      })
      expect(carried).toEqual([`reader@example.com [Confirm](${LINK})`])
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        status: 'sent', attempts: 1, connectorLabel: connector.label, providerMessageId: 'provider-id-1',
        nextAttemptAt: null, error: null,
      })
    })

    it('sends with the wording of the moment it leaves, not of the moment it was queued', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      await h.db`
        insert into mail_templates (template_key, subject, body_markdown)
        values ('queue.welcome', 'Edited subject', 'Edited [link]({link})')
      `
      let subject = ''
      await drain(async (_c, _s, mail) => { subject = mail.subject; return null })
      expect(subject).toBe('Edited subject')
    })

    it('keeps an email whose provider is unreachable and tries again after the wait', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      let calls = 0
      const flaky: MailCarrier = async () => {
        calls += 1
        if (calls === 1) throw new MailDeliveryError('Could not connect to the SMTP server.', { retry: 'later' })
        return null
      }
      await drain(flaky)
      const [waiting] = await queueRows()
      expect(waiting.attempts).toBe(1)
      expect(waiting.claimed_at).toBeNull()
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        status: 'queued', attempts: 1, error: 'Could not connect to the SMTP server.',
      })

      // Not due yet: nothing is tried.
      now += 20_000
      await drain(flaky)
      expect(calls).toBe(1)

      now += 20_000
      await drain(flaky)
      expect(calls).toBe(2)
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'sent', attempts: 2, error: null })
    })

    it('gives up at once on a message the provider judged, and says why', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      let calls = 0
      await drain(async () => {
        calls += 1
        throw new MailDeliveryError('The SMTP server rejected the sender or recipient address.')
      })
      expect(calls).toBe(1)
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        status: 'failed', attempts: 1, error: 'The SMTP server rejected the sender or recipient address.',
      })
    })

    it('gives up after a day of temporary failures', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      let calls = 0
      const down: MailCarrier = async () => {
        calls += 1
        throw new MailDeliveryError('Provider is having trouble.', { retry: 'later' })
      }
      for (let round = 0; round < 40 && (await queueRows()).length > 0; round += 1) {
        await drain(down)
        now += 8 * HOUR
      }
      expect(await queueRows()).toHaveLength(0)
      expect(calls).toBeGreaterThan(2)
      expect(calls).toBeLessThan(12)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'failed', attempts: calls })
    })

    it('holds every email back for a minute when the provider is rate-limiting', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      await queueTemplateMail(h.db, { ...MAIL, to: 'second@example.com' })
      const seen: string[] = []
      const limited: MailCarrier = async (_c, _s, mail) => {
        seen.push(mail.to)
        if (seen.length === 1) throw new MailDeliveryError('Rate limited.', { retry: 'slow-down' })
        return null
      }
      await drain(limited)
      // The second email was due, but the pause stopped the drain.
      expect(seen).toEqual(['reader@example.com'])

      now += MINUTE + 1000
      await drain(limited)
      expect(seen.slice(1).sort()).toEqual(['reader@example.com', 'second@example.com'])
      expect(await queueRows()).toHaveLength(0)
    })

    it('waits, without losing the email, while email is not set up any more', async () => {
      const connector = await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      await h.db`update mail_settings set default_connector_id = null`
      let calls = 0
      const carrier: MailCarrier = async () => { calls += 1; return null }
      await drain(carrier)
      expect(calls).toBe(0)
      // Not the email's failure: no attempt is counted, and it is due at once.
      expect((await queueRows())[0].attempts).toBe(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'queued', attempts: 0 })
      expect((await listMailActivity(h.db)).waitingError).toContain('Email is not set up')

      await h.db`update mail_settings set default_connector_id = ${connector.id}`
      await drain(carrier)
      expect(calls).toBe(1)
      expect(await queueRows()).toHaveLength(0)
    })

    it('fails an email whose template is gone by the time it is sent', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      await h.db`update mail_queue set kind = 'removed.template'`
      await drain(async () => null)
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'failed' })
    })

    it('sends the core\'s email before a plugin\'s that was queued earlier', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, { ...MAIL, to: 'plugin@example.com' })
      await h.db`update mail_queue set lane = 1, source = 'acme.shop'`
      await queueTemplateMail(h.db, { ...MAIL, to: 'core@example.com' })
      const order: string[] = []
      await drain(async (_c, _s, mail) => { order.push(mail.to); return null })
      expect(order).toEqual(['core@example.com', 'plugin@example.com'])
    })
  })

  describe('member emails', () => {
    it('are queued by the request and delivered by the worker', async () => {
      await readyConnector()
      queueMemberMail(h.db, { kind: 'reset', to: 'member@example.com', link: LINK })
      await flushMemberMail()
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ kind: 'member.reset', status: 'queued' })

      let text = ''
      await drain(async (_c, _s, mail) => { text = mail.text; return null })
      expect(text).toContain(LINK)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ kind: 'member.reset', status: 'sent' })
    })
  })

  describe('deadlines', () => {
    const deliverBefore = async () => {
      const { rows } = await h.db<{ kind: string; deliver_before: string | Date }>`
        select kind, deliver_before from mail_queue order by outbox_id
      `
      return rows.map((row) => ({ kind: row.kind, inMinutes: Math.round((new Date(row.deliver_before).getTime() - Date.now()) / MINUTE) }))
    }

    it('gives a member email the life of the link in it, and a notice a day', async () => {
      await readyConnector()
      queueMemberMail(h.db, { kind: 'magic', to: 'm@example.com', link: LINK })
      await flushMemberMail()
      queueMemberMail(h.db, { kind: 'reset', to: 'm@example.com', link: LINK })
      await flushMemberMail()
      queueMemberMail(h.db, { kind: 'invite', to: 'm@example.com', link: LINK })
      await flushMemberMail()
      queueMemberMail(h.db, { kind: 'password_changed', to: 'm@example.com' })
      await flushMemberMail()
      expect(await deliverBefore()).toEqual([
        { kind: 'member.magic', inMinutes: 15 },
        { kind: 'member.reset', inMinutes: 60 },
        { kind: 'member.invite', inMinutes: 7 * 24 * 60 },
        { kind: 'member.password_changed', inMinutes: 24 * 60 },
      ])
    })

    it('never sends a sign-in link after it expired, however long the provider was down', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, { ...MAIL, deliverBefore: now + 15 * MINUTE })
      let calls = 0
      let providerUp = false
      const carrier: MailCarrier = async () => {
        calls += 1
        if (!providerUp) throw new MailDeliveryError('Could not connect to the SMTP server.', { retry: 'later' })
        return null
      }
      // Tried at 0, 30 s, 2.5 min and 12.5 min; the next try would be past the 15 minutes.
      for (let round = 0; round < 12 && (await queueRows()).length > 0; round += 1) {
        await drain(carrier)
        now += 2 * MINUTE
      }
      expect(await queueRows()).toHaveLength(0)
      expect(calls).toBe(4)
      const entry = (await listMailActivity(h.db)).entries[0]
      expect(entry).toMatchObject({ status: 'failed', attempts: 4 })
      expect(entry.error).toBe(
        'Not sent: the time in which this email was of use ran out before it could be delivered. Last error: Could not connect to the SMTP server.',
      )

      // Twenty hours later the provider is back: nothing is left to send.
      providerUp = true
      now += 20 * HOUR
      await drain(carrier)
      expect(calls).toBe(4)
    })

    it('fails an email found past its deadline without handing it to the provider', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, { ...MAIL, deliverBefore: now + 15 * MINUTE })
      let calls = 0
      now += 16 * MINUTE
      await drain(async () => { calls += 1; return null })
      expect(calls).toBe(0)
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        status: 'failed',
        attempts: 0,
        error: 'Not sent: the time in which this email was of use ran out before it could be delivered.',
      })
    })
  })

  describe('a connector that refuses the account', () => {
    const refusing: MailCarrier = async () => {
      throw new MailDeliveryError('Resend rejected the API key or its permissions.', { retry: 'connector' })
    }

    it('pauses delivery at once, holds every email and says why, instead of retrying for a day', async () => {
      const connector = await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      await queueTemplateMail(h.db, { ...MAIL, to: 'second@example.com' })
      let calls = 0
      const counting: MailCarrier = async (...args) => { calls += 1; return refusing(...args) }
      await drain(counting)
      // One refused login, not one per email.
      expect(calls).toBe(1)
      expect((await getMailConnector(h.db, connector.id))).toMatchObject({
        deliveryPaused: true, lastError: 'Resend rejected the API key or its permissions.',
      })
      expect((await queueRows()).map((row) => row.attempts)).toEqual([0, 0])
      const activity = await listMailActivity(h.db)
      expect(activity.waitingError).toBe('Resend rejected the API key or its permissions.')
      expect(activity.totals).toEqual({ queued: 2, sent: 0, failed: 0, captured: 0 })
      expect(activity.entries.find((entry) => entry.to === MAIL.to)).toMatchObject({
        status: 'queued', attempts: 0, nextAttemptAt: null, error: 'Resend rejected the API key or its permissions.',
      })

      // Hours of ticks later, still not one more login attempt.
      for (let tick = 0; tick < 20; tick += 1) {
        now += 30 * MINUTE
        await drain(counting)
      }
      expect(calls).toBe(1)
      expect(await queueRows()).toHaveLength(2)
    })

    it('sends what was held as soon as the secret is replaced', async () => {
      const connector = await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      await queueTemplateMail(h.db, { ...MAIL, to: 'second@example.com' })
      await drain(refusing)
      await setMailConnectorSecret(h.db, connector.id, 'the-right-secret')
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: false, lastError: null })
      const sent: string[] = []
      await drain(async (_c, _s, mail) => { sent.push(mail.to); return null })
      expect(sent).toEqual([MAIL.to, 'second@example.com'])
      expect((await listMailActivity(h.db)).totals).toMatchObject({ queued: 0, sent: 2 })
    })

    it('resumes after a send through the connector works, as the connector test does', async () => {
      const connector = await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      await drain(refusing)
      await noteConnectorUse(h.db, connector.id, null)
      let calls = 0
      await drain(async () => { calls += 1; return null })
      expect(calls).toBe(1)
      expect(await queueRows()).toHaveLength(0)
    })

    it('still fails a held email when its deadline passes', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, { ...MAIL, deliverBefore: now + 15 * MINUTE })
      await drain(refusing)
      now += 16 * MINUTE
      let calls = 0
      await drain(async () => { calls += 1; return null })
      expect(calls).toBe(0)
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0].error).toBe(
        'Not sent: the time in which this email was of use ran out before it could be delivered. Last error: Resend rejected the API key or its permissions.',
      )
    })
  })

  describe('one recipient\'s trouble', () => {
    it('retries a greylisted recipient alone and sends everyone else\'s email in the same pass', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, { ...MAIL, to: 'greylisted@example.com' })
      await queueTemplateMail(h.db, { ...MAIL, to: 'member@example.com' })
      const seen: string[] = []
      await drain(async (_c, _s, mail) => {
        seen.push(mail.to)
        if (mail.to === 'greylisted@example.com') {
          // What `retryForSmtpFailure` makes of a 451.
          throw new MailDeliveryError('The SMTP server refused the message (code 451).', { retry: 'later' })
        }
        return null
      })
      expect(seen).toEqual(['greylisted@example.com', 'member@example.com'])
      const rows = await queueRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].attempts).toBe(1)
    })

    it('sends a fresh email before one that is due for a retry', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, { ...MAIL, to: 'retry@example.com' })
      await drain(async () => { throw new MailDeliveryError('Temporary.', { retry: 'later' }) })
      now += HOUR
      await queueTemplateMail(h.db, { ...MAIL, to: 'fresh@example.com' })
      now = Date.now() + HOUR + 5_000
      const order: string[] = []
      await drain(async (_c, _s, mail) => { order.push(mail.to); return null })
      expect(order).toEqual(['fresh@example.com', 'retry@example.com'])
    })
  })

  describe('when the outcome cannot be recorded', () => {
    it('gives the claim back instead of stranding the email', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      let broken = true
      const flaky = new Proxy(h.db, {
        apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          if (broken && args[0].join('').includes('update mail_outbox')) throw new Error('the log is unreachable')
          return Reflect.apply(target, thisArg, args)
        },
      }) as DbClient
      let calls = 0
      const carrier: MailCarrier = async () => { calls += 1; return null }
      await drainMailQueue(flaky, { carrier, now: clock, random: () => 0.5, paceMs: 0 })
      expect(calls).toBe(1)
      const [row] = await queueRows()
      expect(row.claimed_at).toBeNull()

      // At least once: the provider took it, the record did not, so it goes again.
      broken = false
      await drain(carrier)
      expect(calls).toBe(2)
      expect(await queueRows()).toHaveLength(0)
    })
  })

  describe('an email that cannot be queued', () => {
    it('never opens a transaction for a key that cannot be loaded', async () => {
      await readyConnector()
      const before = process.env.INSTATIC_SECRET_KEY
      process.env.INSTATIC_SECRET_KEY = 'not base64 at all !!'
      __resetMasterKeyCacheForTesting()
      try {
        await expect(queueTemplateMail(h.db, MAIL)).rejects.toThrow()
      } finally {
        if (before === undefined) delete process.env.INSTATIC_SECRET_KEY
        else process.env.INSTATIC_SECRET_KEY = before
        __resetMasterKeyCacheForTesting()
      }
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries).toHaveLength(0)
    })

    it('leaves a failed entry in the activity log when a member\'s email is not queued', async () => {
      const before = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        queueMemberMail(h.db, { kind: 'reset', to: 'member@example.com', link: LINK })
        await flushMemberMail()
      } finally {
        process.env.NODE_ENV = before
      }
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({
        kind: 'member.reset',
        to: 'member@example.com',
        status: 'failed',
        attempts: 0,
        error: 'Not queued, so never sent: Email is not set up. Add a connector and a sender address in the Email workspace.',
      })
    })
  })

  describe('claims', () => {
    it('leaves a freshly claimed email alone and takes back one whose process died', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      await h.db`update mail_queue set claimed_at = ${new Date(now - 20_000).toISOString()}`
      let calls = 0
      const carrier: MailCarrier = async () => { calls += 1; return null }
      await drain(carrier)
      expect(calls).toBe(0)

      // A hand-over is cut off after ten seconds, so a claim a minute old is nobody's.
      now += 50_000
      await drain(carrier)
      expect(calls).toBe(1)
      expect(await queueRows()).toHaveLength(0)
    })

    it('hands each email to exactly one of two drains running at once', async () => {
      await readyConnector()
      for (let index = 0; index < 6; index += 1) {
        await queueTemplateMail(h.db, { ...MAIL, to: `reader${index}@example.com` })
      }
      const seen: string[] = []
      const carrier: MailCarrier = async (_c, _s, mail) => {
        seen.push(mail.to)
        await new Promise((resolve) => setTimeout(resolve, 2))
        return null
      }
      await Promise.all([drain(carrier), drain(carrier)])
      expect(seen.sort()).toEqual([0, 1, 2, 3, 4, 5].map((index) => `reader${index}@example.com`))
    })
  })

  describe('retry schedule', () => {
    it('grows from half a minute to hours and repeats the last wait', () => {
      const waits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50].map((attempts) => mailRetryDelayMs(attempts, 0.5))
      expect(waits.slice(0, 4)).toEqual([30_000, 2 * MINUTE, 10 * MINUTE, 30 * MINUTE])
      expect(waits[8]).toBe(8 * HOUR)
      expect(waits[10]).toBe(8 * HOUR)
      for (let index = 1; index < 9; index += 1) expect(waits[index]).toBeGreaterThan(waits[index - 1])
    })

    it('moves each wait by at most a fifth either way', () => {
      expect(mailRetryDelayMs(1, 0)).toBe(24_000)
      expect(mailRetryDelayMs(1, 0.999999)).toBeLessThanOrEqual(36_000)
      expect(mailRetryDelayMs(1, 0.999999)).toBeGreaterThan(35_000)
    })
  })

  describe('which refusals are retried', () => {
    it('reads an HTTP provider\'s status', () => {
      expect(retryForHttpStatus(429)).toBe('slow-down')
      expect([401, 403].map(retryForHttpStatus)).toEqual(['connector', 'connector'])
      expect([500, 502, 503, 408].map(retryForHttpStatus)).toEqual(Array(4).fill('later'))
      expect([400, 404, 413, 422].map(retryForHttpStatus)).toEqual(Array(4).fill('never'))
    })

    it('reads an SMTP reply code and connection failure', () => {
      const smtp = (fields: { code?: string; responseCode?: number }) => Object.assign(new Error('smtp'), fields)
      // Only 421 speaks for the whole account. Greylisting and a full mailbox are one recipient's.
      expect(retryForSmtpFailure(smtp({ responseCode: 421 }))).toBe('slow-down')
      expect([450, 451, 452, 454].map((responseCode) => retryForSmtpFailure(smtp({ responseCode }))))
        .toEqual(Array(4).fill('later'))
      expect(retryForSmtpFailure(smtp({ code: 'EAUTH', responseCode: 535 }))).toBe('connector')
      expect(retryForSmtpFailure(smtp({ code: 'ETLS' }))).toBe('connector')
      expect(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED'].map((code) => retryForSmtpFailure(smtp({ code }))))
        .toEqual(Array(4).fill('later'))
      expect([550, 552, 554].map((responseCode) => retryForSmtpFailure(smtp({ responseCode }))))
        .toEqual(Array(3).fill('never'))
      expect(retryForSmtpFailure(smtp({ code: 'EENVELOPE' }))).toBe('never')
      expect(retryForSmtpFailure('not an error')).toBe('never')
    })

    it('marks what the HTTP drivers throw', async () => {
      const sender = { fromAddress: 'a@example.com', fromName: 'A', fromHeader: 'a@example.com', replyTo: '' }
      const mail = { to: 'r@example.com', subject: 'S', text: 'T' }
      const answering = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch
      const unreachable = (async () => { throw new Error('socket closed') }) as unknown as typeof fetch
      const retryOf = async (attempt: Promise<unknown>) =>
        ((await attempt.catch((err: unknown) => err)) as MailDeliveryError).retry

      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: answering(429) }))).toBe('slow-down')
      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: answering(503) }))).toBe('later')
      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: answering(422) }))).toBe('never')
      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: unreachable }))).toBe('later')

      const ses = { region: 'eu-central-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE' }
      expect(await retryOf(sendViaSes(ses, 'secret', sender, mail, { fetchImpl: answering(429) }))).toBe('slow-down')
      expect(await retryOf(sendViaSes(ses, 'secret', sender, mail, { fetchImpl: answering(400) }))).toBe('never')
      expect(await retryOf(sendViaSes(ses, 'secret', sender, mail, { fetchImpl: unreachable }))).toBe('later')
    })

    it('defaults a delivery error to no retry', () => {
      expect(new MailDeliveryError('x').retry).toBe('never')
    })
  })
})
