import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { registerMailTemplate, type MailConnector } from '@core/mail'
import { listMailActivity } from '../../../server/mail/activity'
import {
  createMailConnector,
  getMailConnector,
  noteConnectorUse,
  setMailConnectorSecret, pauseConnectorDelivery } from '../../../server/mail/connectors'
import { saveMailDefaults } from '../../../server/mail/defaults'
import type { DbClient } from '../../../server/db/client'
import {
  __resetMailQueuePauseForTesting,
  drainMailQueue,
  mailRetryDelayMs,
  queueTemplateMail,
} from '../../../server/mail/delivery'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'
import { __resetSuspectRecipientsForTesting, MailNotConfiguredError, type MailCarrier } from '../../../server/mail/send'
import { sendViaBrevo, sendViaMailgun, sendViaPostmark, sendViaResend } from '../../../server/mail/apiDrivers'
import { retryForSesError, sendViaSes } from '../../../server/mail/sesDriver'
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
    __resetSuspectRecipientsForTesting()
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
    }>`select id, attempts, next_attempt_at, claimed_at, lane, payload_ciphertext from mail_queue order by outbox_id`
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
      // The plain-text part is read off the rendered body: a link is its words, then its address.
      expect(carried).toEqual([`reader@example.com Confirm (${LINK})`])
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
      // Passes two minutes apart: tried at 0, 2 and 4 minutes. The next try, ten
      // minutes on, would leave the link under a minute of life, so it is not made.
      for (let round = 0; round < 12 && (await queueRows()).length > 0; round += 1) {
        await drain(carrier)
        now += 2 * MINUTE
      }
      expect(await queueRows()).toHaveLength(0)
      expect(calls).toBe(3)
      const entry = (await listMailActivity(h.db)).entries[0]
      expect(entry).toMatchObject({ status: 'failed', attempts: 3 })
      expect(entry.error).toBe(
        'Not sent: the time in which this email was of use ran out before it could be delivered. Last error: Could not connect to the SMTP server.',
      )

      // Twenty hours later the provider is back: nothing is left to send.
      providerUp = true
      now += 20 * HOUR
      await drain(carrier)
      expect(calls).toBe(3)
    })

    it('does not send a link with less than a minute of life left', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, { ...MAIL, deliverBefore: now + 15 * MINUTE })
      let calls = 0
      // Fifty seconds before the link stops working: too late to be of use.
      now += 15 * MINUTE - 50_000
      await drain(async () => { calls += 1; return null })
      expect(calls).toBe(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'failed' })
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

      // Ticks inside the next two minutes: not one more login attempt.
      for (let tick = 0; tick < 7; tick += 1) {
        now += 15_000
        await drain(counting)
      }
      expect(calls).toBe(1)
      expect(await queueRows()).toHaveLength(2)
    })

    it('probes with one email every two minutes and resumes by itself when one gets through', async () => {
      const connector = await readyConnector()
      for (const to of ['a@example.com', 'b@example.com', 'c@example.com']) await queueTemplateMail(h.db, { ...MAIL, to })
      let healthy = false
      const seen: string[] = []
      const carrier: MailCarrier = async (_c, _s, mail) => {
        seen.push(mail.to)
        // A server having a bad minute: nothing is wrong with the account.
        if (!healthy) throw new MailDeliveryError('The SMTP server rejected the username or password.', { retry: 'connector' })
        return null
      }
      await drain(carrier)
      expect(seen).toHaveLength(1)

      // Ten minutes of 15-second ticks: one probe per two minutes, never a stream of logins.
      for (let tick = 0; tick < 40; tick += 1) {
        now += 15_000
        await drain(carrier)
      }
      expect(seen).toHaveLength(6)
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: true })
      expect((await queueRows()).map((row) => row.attempts)).toEqual([0, 0, 0])

      // The provider recovers. Nobody touches the connector: the next probe gets through and the rest follows.
      healthy = true
      now += 2 * MINUTE
      await drain(carrier)
      expect(await queueRows()).toHaveLength(0)
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: false, lastError: null })
      expect((await listMailActivity(h.db)).totals).toMatchObject({ queued: 0, sent: 3, failed: 0 })
    })

    it('says why an email accepted during a pause is waiting', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      await drain(refusing)
      await queueTemplateMail(h.db, { ...MAIL, to: 'later@example.com' })
      expect((await listMailActivity(h.db)).entries.find((entry) => entry.to === 'later@example.com')).toMatchObject({
        status: 'queued',
        attempts: 0,
        error: 'Waiting: the connector is paused. Resend rejected the API key or its permissions.',
      })
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

  describe('the last try before a deadline', () => {
    it('is still made when the wait before it would have run past the deadline', async () => {
      await readyConnector()
      const start = now
      const deadline = start + 15 * MINUTE
      await queueTemplateMail(h.db, { ...MAIL, deliverBefore: deadline })
      const attempts: number[] = []
      const down: MailCarrier = async () => {
        attempts.push(now - start)
        throw new MailDeliveryError('Could not reach the provider.', { retry: 'later' })
      }
      // The longest waits the jitter allows.
      while (now < deadline) {
        await drainMailQueue(h.db, { carrier: down, now: clock, random: () => 0.999, paceMs: 0 })
        now += 5_000
      }
      // The last try is at the last useful moment (the margin and two ticks before the deadline), not minutes earlier.
      expect(attempts.at(-1)).toBe(15 * MINUTE - 90_000)
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'failed', attempts: attempts.length })
    })

    it('is made whatever the phase of the worker\'s fifteen-second tick', async () => {
      await readyConnector()
      const TICK = 15_000
      for (const phase of [0, 1_000, 4_000, 7_500, 11_000, 14_999]) {
        const start = now
        const deadline = start + 15 * MINUTE
        await queueTemplateMail(h.db, { ...MAIL, to: `phase${phase}@example.com`, deliverBefore: deadline })
        const attempts: number[] = []
        const down: MailCarrier = async () => {
          attempts.push(deadline - now)
          throw new MailDeliveryError('Could not reach the provider.', { retry: 'later' })
        }
        // The worker only ever looks on its tick, wherever that falls.
        now += phase
        while (now < deadline) {
          await drainMailQueue(h.db, { carrier: down, now: clock, random: () => 0.999, paceMs: 0 })
          now += TICK
        }
        await drainMailQueue(h.db, { carrier: down, now: clock, random: () => 0.999, paceMs: 0 })
        // Its last try came in the last minute and a half, while it was still of use.
        const last = attempts.at(-1) ?? Infinity
        expect({ phase, inTime: last > MINUTE && last <= 90_000 }).toEqual({ phase, inTime: true })
        expect(await queueRows()).toHaveLength(0)
      }
    })
  })

  describe('a refusal that could be the account\'s or one recipient\'s', () => {
    const forbidden = (blocked: (to: string) => boolean): MailCarrier => async (_c, _s, mail) => {
      if (blocked(mail.to)) throw new MailDeliveryError('Resend rejected the API key or its permissions.', { retry: 'suspect' })
      return null
    }

    it('does not pause for one visitor\'s address, however often it is tried: other mail still flows', async () => {
      const connector = await readyConnector()
      // A visitor signs up with an address the provider refuses, again and again.
      for (let index = 0; index < 5; index += 1) await queueTemplateMail(h.db, { ...MAIL, to: 'blocked@example.com' })
      await queueTemplateMail(h.db, { ...MAIL, to: 'member@example.com' })
      const sent: string[] = []
      const carrier = forbidden((to) => to === 'blocked@example.com')
      await drain(async (c, s, mail) => { const id = await carrier(c, s, mail); sent.push(mail.to); return id })
      expect(sent).toEqual(['member@example.com'])
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: false })
      // The refused ones are retried like any temporary failure, each on its own.
      expect((await queueRows()).map((row) => row.attempts)).toEqual([1, 1, 1, 1, 1])
    })

    it('pauses when three different recipients in a row are refused', async () => {
      const connector = await readyConnector()
      for (const to of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
        await queueTemplateMail(h.db, { ...MAIL, to })
      }
      let calls = 0
      const carrier = forbidden(() => true)
      await drain(async (c, s, mail) => { calls += 1; return carrier(c, s, mail) })
      expect(calls).toBe(3)
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: true })
      // The first two were retried; the third and the rest are held with no attempt counted.
      expect((await queueRows()).map((row) => row.attempts).sort()).toEqual([0, 0, 1, 1])
    })

    it('probes with an email that was not refused, so junk addresses cannot keep a sign-in link waiting', async () => {
      const connector = await readyConnector()
      for (const to of ['junk1@example.com', 'junk2@example.com', 'junk3@example.com', 'junk4@example.com']) {
        await queueTemplateMail(h.db, { ...MAIL, to })
      }
      const carrier = forbidden((to) => to.startsWith('junk'))
      await drain(carrier)
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: true })

      // A real member asks for a link while delivery is paused, behind all of those.
      await queueTemplateMail(h.db, { ...MAIL, to: 'member@example.com' })
      const tried: string[] = []
      now += 2 * MINUTE
      await drain(async (c, s, mail) => { tried.push(mail.to); return carrier(c, s, mail) })
      // The probe is the member's email: newest, and never refused. It gets through and lifts the pause.
      expect(tried[0]).toBe('member@example.com')
      // The junk is tried again after it, and refused again, but an email that
      // was already counted once does not pause delivery a second time.
      for (let round = 0; round < 6; round += 1) {
        now += 10 * MINUTE
        await drain(carrier)
      }
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: false })
      expect((await listMailActivity(h.db, { status: 'sent' })).entries.map((entry) => entry.to)).toEqual(['member@example.com'])
    })

    it('probes with the newest refused email when there is no other', async () => {
      const connector = await readyConnector()
      for (const to of ['a@example.com', 'b@example.com', 'c@example.com']) await queueTemplateMail(h.db, { ...MAIL, to })
      await drain(forbidden(() => true))
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: true })
      const tried: string[] = []
      now += 2 * MINUTE
      await drain(async (_c, _s, mail) => { tried.push(mail.to); return null })
      expect(tried[0]).toBe('c@example.com')
      expect(await queueRows()).toHaveLength(0)
    })

    it('gives a probe\'s turn to the next email when the first is refused for its own recipient, three at most', async () => {
      const connector = await readyConnector()
      await queueTemplateMail(h.db, { ...MAIL, to: 'first@example.com' })
      await drain(async () => { throw new MailDeliveryError('Resend rejected the API key or its permissions.', { retry: 'connector' }) })
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: true })

      for (const to of ['typo1@example.invalid', 'typo2@example.invalid', 'typo3@example.invalid', 'typo4@example.invalid']) {
        await queueTemplateMail(h.db, { ...MAIL, to })
      }
      const tried: string[] = []
      const carrier: MailCarrier = async (_c, _s, mail) => {
        tried.push(mail.to)
        if (mail.to.endsWith('.invalid')) throw new MailDeliveryError('The SMTP server rejected the recipient address.')
        return null
      }
      // One turn tries three, newest first, and no more: all were the recipients' own refusals.
      now += 2 * MINUTE
      await drain(carrier)
      expect(tried).toEqual(['typo4@example.invalid', 'typo3@example.invalid', 'typo2@example.invalid'])
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: true })

      // The next turn reaches an email that can be delivered, and delivery resumes.
      now += 2 * MINUTE
      await drain(carrier)
      expect(tried.slice(3)).toEqual(['typo1@example.invalid', 'first@example.com'])
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: false })
    })

    it('does not spend a probe\'s turn while nothing is waiting', async () => {
      const connector = await readyConnector()
      await pauseConnectorDelivery(h.db, connector.id, now)
      let calls = 0
      const carrier: MailCarrier = async () => { calls += 1; return null }
      // Ticks with an empty queue, past the two minutes.
      for (let tick = 0; tick < 12; tick += 1) {
        now += 15_000
        await drain(carrier)
      }
      // The first email to arrive is tried at once, not two minutes later.
      await queueTemplateMail(h.db, MAIL)
      await drain(carrier)
      expect(calls).toBe(1)
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: false })
    })

    it('forgets a refusal after ten minutes', async () => {
      const connector = await readyConnector()
      const carrier = forbidden(() => true)
      await queueTemplateMail(h.db, { ...MAIL, to: 'a@example.com' })
      await drain(carrier)
      await queueTemplateMail(h.db, { ...MAIL, to: 'b@example.com' })
      await drain(carrier)
      // The third different recipient comes eleven minutes after the first two.
      await h.db`delete from mail_queue`
      now += 11 * MINUTE
      await queueTemplateMail(h.db, { ...MAIL, to: 'c@example.com' })
      now = Math.max(now, Date.now() + 5_000)
      await drain(carrier)
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: false })
    })

    it('starts counting again after an email gets through', async () => {
      const connector = await readyConnector()
      for (const to of ['a@example.com', 'b@example.com', 'fine@example.com', 'c@example.com', 'd@example.com']) {
        await queueTemplateMail(h.db, { ...MAIL, to })
      }
      await drain(forbidden((to) => to !== 'fine@example.com'))
      expect(await getMailConnector(h.db, connector.id)).toMatchObject({ deliveryPaused: false })
      expect(await queueRows()).toHaveLength(4)
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
    /** A database whose statements matching `broken()` throw. */
    const failing = (matches: (sql: string) => boolean) =>
      new Proxy(h.db, {
        apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          if (matches(args[0].join(''))) throw new Error('the database refused the write')
          return Reflect.apply(target, thisArg, args)
        },
      }) as DbClient

    it('does not send an accepted email again when the log cannot be updated', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      let broken = true
      const flaky = failing((sql) => broken && sql.includes('update mail_outbox'))
      let calls = 0
      const carrier: MailCarrier = async () => { calls += 1; return null }
      // Twenty passes, as five minutes of ticks would make.
      for (let pass = 0; pass < 20; pass += 1) {
        now += 15_000
        await drainMailQueue(flaky, { carrier, now: clock, random: () => 0.5, paceMs: 0 })
      }
      expect(calls).toBe(1)
      expect(await queueRows()).toHaveLength(1)

      broken = false
      await drain(carrier)
      expect(calls).toBe(1)
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'sent', attempts: 1 })
    })

    it('does not send it again even when the acceptance itself cannot be written', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      let broken = true
      const flaky = failing((sql) => broken && (sql.includes('set accepted_at') || sql.includes('update mail_outbox')))
      let calls = 0
      const carrier: MailCarrier = async () => { calls += 1; return null }
      for (let pass = 0; pass < 20; pass += 1) {
        now += 5 * MINUTE
        await drainMailQueue(flaky, { carrier, now: clock, random: () => 0.5, paceMs: 0 })
      }
      expect(calls).toBe(1)

      broken = false
      now += 9 * HOUR
      await drain(carrier)
      expect(calls).toBe(1)
      expect(await queueRows()).toHaveLength(0)
      expect((await listMailActivity(h.db)).entries[0]).toMatchObject({ status: 'sent' })
    })

    it('puts an email whose failed attempt could not be recorded back with a growing wait', async () => {
      await readyConnector()
      await queueTemplateMail(h.db, MAIL)
      const flaky = failing((sql) => sql.includes('update mail_outbox'))
      let calls = 0
      const carrier: MailCarrier = async () => {
        calls += 1
        throw new MailDeliveryError('Temporary.', { retry: 'later' })
      }
      for (let pass = 0; pass < 20; pass += 1) {
        now += 15_000
        await drainMailQueue(flaky, { carrier, now: clock, random: () => 0.5, paceMs: 0 })
      }
      // Five minutes of passes: tried at 0, 30 s and 2.5 min, not twenty times.
      expect(calls).toBe(3)
      expect((await queueRows())[0].claimed_at).toBeNull()
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

      // A hand-over is cut off after ten seconds, so a claim two minutes old is nobody's.
      now += 50_000
      await drain(carrier)
      expect(calls).toBe(0)
      now += 60_000
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
      // 401 is always the key. A bare 403 is not: it is also how one recipient is refused.
      expect([401, 403].map(retryForHttpStatus)).toEqual(['connector', 'suspect'])
      expect([500, 502, 503, 408].map(retryForHttpStatus)).toEqual(Array(4).fill('later'))
      expect([400, 404, 413, 422].map(retryForHttpStatus)).toEqual(Array(4).fill('never'))
    })

    it('slows everything down for a throttled account, and only one message for a throttled recipient', () => {
      const smtp = (fields: { responseCode: number; response: string; command?: string }) => Object.assign(new Error('smtp'), fields)
      expect(retryForSmtpFailure(smtp({ responseCode: 451, response: '451 4.7.0 Too many messages, slow down' }))).toBe('slow-down')
      expect(retryForSmtpFailure(smtp({ responseCode: 454, response: '454 4.7.0 Throttling failure: daily quota exceeded' }))).toBe('slow-down')
      // Anyone can cause these by giving an address: they must not hold other mail back.
      expect(retryForSmtpFailure(smtp({ responseCode: 450, response: '450 4.7.1 <x@example.com>: Recipient address rejected: rate limited' }))).toBe('later')
      expect(retryForSmtpFailure(smtp({ responseCode: 450, response: '450 4.2.1 The user you are trying to contact is receiving mail too quickly' }))).toBe('later')
      expect(retryForSmtpFailure(smtp({ responseCode: 452, response: '452 4.7.1 rate limit exceeded', command: 'RCPT TO' }))).toBe('later')
      // 421 closes the connection on the account, whatever it says.
      expect(retryForSmtpFailure(smtp({ responseCode: 421, response: '421 4.7.0 recipient rate limit, try later' }))).toBe('slow-down')
    })

    it('reads an SMTP reply code and connection failure', () => {
      const smtp = (fields: { code?: string; responseCode?: number }) => Object.assign(new Error('smtp'), fields)
      // Only 421 speaks for the whole account. Greylisting and a full mailbox are one recipient's.
      expect(retryForSmtpFailure(smtp({ responseCode: 421 }))).toBe('slow-down')
      expect([450, 451, 452, 454].map((responseCode) => retryForSmtpFailure(smtp({ responseCode }))))
        .toEqual(Array(4).fill('later'))
      expect(retryForSmtpFailure(smtp({ code: 'EAUTH', responseCode: 535 }))).toBe('connector')
      // A login answered with a temporary code is the server's bad minute, not a wrong password.
      expect(retryForSmtpFailure(smtp({ code: 'EAUTH', responseCode: 454 }))).toBe('later')
      expect(retryForSmtpFailure(smtp({ code: 'EAUTH', responseCode: 421 }))).toBe('slow-down')
      expect(retryForSmtpFailure(Object.assign(new Error('smtp'), { responseCode: 450, response: '450 4.7.0 Too many messages, rate limit exceeded' }))).toBe('slow-down')
      expect(retryForSmtpFailure(Object.assign(new Error('smtp'), { responseCode: 451, response: '451 4.7.1 Greylisted, please try again later' }))).toBe('later')
      expect(retryForSmtpFailure(smtp({ responseCode: 530 }))).toBe('connector')
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

      // An empty body: the status alone decides.
      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: answering(429) }))).toBe('slow-down')
      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: answering(401) }))).toBe('connector')
      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: answering(403) }))).toBe('suspect')
      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: answering(503) }))).toBe('later')
      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: answering(422) }))).toBe('never')
      expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: unreachable }))).toBe('later')

      const ses = { region: 'eu-central-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE' }
      expect(await retryOf(sendViaSes(ses, 'secret', sender, mail, { fetchImpl: answering(429) }))).toBe('slow-down')
      expect(await retryOf(sendViaSes(ses, 'secret', sender, mail, { fetchImpl: answering(400) }))).toBe('never')
      expect(await retryOf(sendViaSes(ses, 'secret', sender, mail, { fetchImpl: unreachable }))).toBe('later')
    })

    describe('from each provider\'s own error body', () => {
      const sender = { fromAddress: 'a@example.com', fromName: 'A', fromHeader: 'a@example.com', replyTo: '' }
      const mail = { to: 'r@example.com', subject: 'S', text: 'T' }
      const answering = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch
      const retryOf = async (attempt: Promise<unknown>) =>
        ((await attempt.catch((err: unknown) => err)) as MailDeliveryError).retry

      const resend: Array<[string, number, unknown, string]> = [
        ['a wrong key', 403, { statusCode: 403, name: 'invalid_api_key', message: 'API key is invalid' }, 'connector'],
        ['no key', 401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key in the authorization header.' }, 'connector'],
        ['a key that may not send', 401, { statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }, 'connector'],
        ['a testing account writing to somebody else', 403, { statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address (owner@example.com).' }, 'never'],
        ['a suppressed recipient', 403, { statusCode: 403, name: 'validation_error', message: 'This recipient is on the suppression list.' }, 'never'],
        ['the daily quota', 429, { statusCode: 429, name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' }, 'slow-down'],
        ['a domain that is not verified', 403, { statusCode: 403, name: 'validation_error', message: 'The example.com domain is not verified.' }, 'suspect'],
        ['a malformed recipient', 422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' }, 'never'],
        ['a rate limit', 429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' }, 'slow-down'],
        ['trouble at Resend', 500, { statusCode: 500, name: 'internal_server_error', message: 'Unexpected error.' }, 'later'],
      ]
      for (const [what, status, body, expected] of resend) {
        it(`Resend: ${what} is ${expected}`, async () => {
          expect(await retryOf(sendViaResend('key', sender, mail, { fetchImpl: answering(status, body) }))).toBe(expected)
        })
      }

      const postmark: Array<[string, number, unknown, string]> = [
        ['a wrong server token', 401, { ErrorCode: 10, Message: 'Bad or missing Server API token.' }, 'connector'],
        ['a sender signature that does not exist', 422, { ErrorCode: 400, Message: 'The \'From\' address you supplied is not a Sender Signature on your account.' }, 'connector'],
        ['a sender signature that is not confirmed', 422, { ErrorCode: 401, Message: 'Sender signature not confirmed.' }, 'connector'],
        ['an account that may not send', 422, { ErrorCode: 405, Message: 'You ran out of credits.' }, 'connector'],
        ['an inactive recipient', 422, { ErrorCode: 406, Message: 'You tried to send to recipient(s) that have been marked as inactive.' }, 'never'],
        ['a recipient outside the pending account\'s domain', 422, { ErrorCode: 412, Message: 'While your account is pending approval, all recipient addresses must share the same domain as the From address.' }, 'never'],
        ['an invalid address', 422, { ErrorCode: 300, Message: 'Invalid \'To\' address.' }, 'never'],
        ['trouble at Postmark', 500, { ErrorCode: 0, Message: 'Internal Server Error' }, 'later'],
      ]
      for (const [what, status, body, expected] of postmark) {
        it(`Postmark: ${what} is ${expected}`, async () => {
          expect(await retryOf(sendViaPostmark('token', sender, mail, { fetchImpl: answering(status, body) }))).toBe(expected)
        })
      }

      const mailgunConfig = { domain: 'mg.example.com', region: 'us' as const }
      const mailgun: Array<[string, number, unknown, string]> = [
        ['a wrong key', 401, { message: 'Forbidden' }, 'connector'],
        ['a sandbox domain writing to an address that is not authorised', 403, { message: 'Domain sandbox123.mailgun.org is not allowed to send: Sandbox subdomains are for test purposes only. Please add your own domain or add the address to authorized recipients in Account Settings.' }, 'never'],
        ['an account that is disabled', 403, { message: 'Domain mg.example.com is not allowed to send: The domain is unverified and requires DNS configuration.' }, 'suspect'],
        ['a bad recipient', 400, { message: 'to parameter is not a valid address. please check documentation' }, 'never'],
        ['a rate limit', 429, { message: 'Too Many Requests' }, 'slow-down'],
      ]
      for (const [what, status, body, expected] of mailgun) {
        it(`Mailgun: ${what} is ${expected}`, async () => {
          expect(await retryOf(sendViaMailgun(mailgunConfig, 'key', sender, mail, { fetchImpl: answering(status, body) }))).toBe(expected)
        })
      }

      const brevo: Array<[string, number, unknown, string]> = [
        ['a wrong key', 401, { code: 'unauthorized', message: 'Key not found' }, 'connector'],
        ['an account still under validation', 403, { code: 'account_under_validation', message: 'Your account is under validation.' }, 'connector'],
        ['no credits', 402, { code: 'not_enough_credits', message: 'Not enough credits.' }, 'connector'],
        ['a refusal that names no one', 403, { code: 'permission_denied', message: 'Unable to send email.' }, 'suspect'],
        ['a refusal that names the recipient', 403, { code: 'permission_denied', message: 'Unable to send email. The recipient is blocklisted.' }, 'never'],
        ['too many requests', 429, { code: 'too_many_requests', message: 'Rate limit exceeded.' }, 'slow-down'],
        ['a bad recipient', 400, { code: 'invalid_parameter', message: 'email is not valid in to' }, 'never'],
      ]
      for (const [what, status, body, expected] of brevo) {
        it(`Brevo: ${what} is ${expected}`, async () => {
          expect(await retryOf(sendViaBrevo('key', sender, mail, { fetchImpl: answering(status, body) }))).toBe(expected)
        })
      }

      const ses = { region: 'eu-central-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE' }
      const sesCases: Array<[string, number, unknown, Record<string, string>, string]> = [
        ['a wrong secret key', 403, { message: 'The request signature we calculated does not match the signature you provided.' }, { 'x-amzn-errortype': 'SignatureDoesNotMatch' }, 'connector'],
        ['an unknown access key', 403, { message: 'The security token included in the request is invalid.' }, { 'x-amzn-errortype': 'UnrecognizedClientException:http://internal.amazon.com/coral/com.amazon.coral.service/' }, 'connector'],
        ['a key without permission', 403, { __type: 'com.amazon.coral.service#AccessDeniedException', Message: 'User is not authorized to perform ses:SendEmail' }, {}, 'connector'],
        ['an account whose sending is paused', 400, { message: 'Sending paused for this account.' }, { 'x-amzn-errortype': 'SendingPausedException' }, 'connector'],
        ['a sandbox recipient that is not verified', 400, { message: 'Email address is not verified. The following identities failed the check in region EU-CENTRAL-1: r@example.com' }, { 'x-amzn-errortype': 'MessageRejected' }, 'never'],
        ['a 403 that says nothing', 403, {}, {}, 'suspect'],
        ['throttling', 429, { message: 'Maximum sending rate exceeded.' }, { 'x-amzn-errortype': 'TooManyRequestsException' }, 'slow-down'],
        ['throttling answered with 400', 400, { message: 'Rate exceeded' }, { 'x-amzn-errortype': 'ThrottlingException' }, 'slow-down'],
        ['a quota answered with 400', 400, { message: 'Daily message quota exceeded.' }, { 'x-amzn-errortype': 'LimitExceededException' }, 'slow-down'],
        ['a clock that has drifted', 403, { message: 'Signature expired: 20261118T101500Z is now earlier than 20261118T103000Z' }, { 'x-amzn-errortype': 'InvalidSignatureException' }, 'later'],
        ['a request that expired', 400, { message: 'Request has expired.' }, { 'x-amzn-errortype': 'RequestExpired' }, 'later'],
      ]
      for (const [what, status, body, headers, expected] of sesCases) {
        it(`Amazon SES: ${what} is ${expected}`, async () => {
          expect(await retryOf(sendViaSes(ses, 'secret', sender, mail, { fetchImpl: answering(status, body, headers) }))).toBe(expected)
        })
      }

      it('reads an AWS error type with a namespace or a suffix', () => {
        expect(retryForSesError(403, 'com.amazon.coral.service#AccessDeniedException')).toBe('connector')
        expect(retryForSesError(403, 'InvalidClientTokenId:http://example/')).toBe('connector')
        expect(retryForSesError(403, '')).toBe('suspect')
      })
    })

    it('defaults a delivery error to no retry', () => {
      expect(new MailDeliveryError('x').retry).toBe('never')
    })
  })
})
