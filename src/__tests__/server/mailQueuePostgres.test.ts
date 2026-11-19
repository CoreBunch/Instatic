/**
 * The mail queue on Postgres, with two workers on two connection pools, as
 * two server instances have. Runs when `INSTATIC_TEST_POSTGRES_URL` names a
 * database the tests may wipe, as CI's test job does (`.github/workflows/ci.yml`).
 * Locally:
 *
 *   initdb -D /tmp/pg -U postgres -A trust
 *   pg_ctl -D /tmp/pg -o "-p 55439 -c unix_socket_directories=''" start
 *   psql -h 127.0.0.1 -p 55439 -U postgres -c 'create database mailq'
 *   INSTATIC_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55439/mailq \
 *     bun test src/__tests__/server/mailQueuePostgres.test.ts
 *
 * The worker takes no lock between instances: a row's conditional claim is
 * the only coordination. This is the test that it is enough. The limits on a
 * plugin's email are counters raised by one conditional UPDATE, and this is
 * the test that two instances cannot exceed them between them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { registerMailTemplate } from '@core/mail'
import { createDbClient } from '../../../server/db'
import type { DbClient } from '../../../server/db/client'
import { runMigrations } from '../../../server/db/runMigrations'
import { listMailActivity } from '../../../server/mail/activity'
import { __resetMailQueuePauseForTesting, drainMailQueue, queueTemplateMail } from '../../../server/mail/delivery'
import {
  MAIL_EXTERNAL_HOURLY_LIMIT,
  MAIL_PER_RECIPIENT_HOURLY_LIMIT,
  MailLimitError,
  reserveRecipientSlot,
} from '../../../server/mail/limits'
import type { MailCarrier } from '../../../server/mail/send'

const url = process.env.INSTATIC_TEST_POSTGRES_URL

registerMailTemplate({
  key: 'queue.pg',
  label: 'Queue on Postgres',
  description: 'Test fixture.',
  group: 'Test',
  variables: [],
  defaultSubject: 'Hello',
  defaultBody: 'Hello.',
})

describe.skipIf(!url)('mail queue on Postgres, two workers', () => {
  let first: DbClient
  let second: DbClient

  beforeAll(async () => {
    const a = createDbClient(url ?? '')
    const b = createDbClient(url ?? '')
    first = a.db
    second = b.db
    await runMigrations(first, a.migrations)
    await first`delete from mail_queue`
    await first`delete from mail_outbox`
    await first`delete from mail_settings`
    await first`delete from mail_connectors`
    await first`
      insert into mail_connectors (id, kind, label, config_json)
      values ('pg-test', 'smtp', 'Relay', ${{ host: 'smtp.example.com', port: 587, username: '' }})
    `
    await first`
      insert into mail_settings (id, default_connector_id, from_address, from_name, reply_to)
      values ('default', 'pg-test', 'hello@example.com', 'Example', '')
    `
    __resetMailQueuePauseForTesting()
  })

  afterAll(async () => {
    await first?.close()
    await second?.close()
  })

  it('sends every email exactly once and leaves the queue empty', async () => {
    const total = 60
    for (let index = 0; index < total; index += 1) {
      await queueTemplateMail(first, { key: 'queue.pg', to: `reader${index}@example.com`, variables: {} })
    }
    const sent: string[] = []
    const carrier: MailCarrier = async (_connector, _sender, mail) => {
      sent.push(mail.to)
      await new Promise((resolve) => setTimeout(resolve, 3))
      return null
    }
    const clock = () => Date.now() + 5_000
    await Promise.all([
      drainMailQueue(first, { carrier, now: clock, paceMs: 0 }),
      drainMailQueue(second, { carrier, now: clock, paceMs: 0 }),
      drainMailQueue(first, { carrier, now: clock, paceMs: 0 }),
      drainMailQueue(second, { carrier, now: clock, paceMs: 0 }),
    ])
    expect(sent).toHaveLength(total)
    expect(new Set(sent).size).toBe(total)
    expect((await first`select id from mail_queue`).rows).toHaveLength(0)
    expect((await listMailActivity(first)).totals).toEqual({ queued: 0, sent: total, failed: 0, captured: 0 })
    // Nothing is left held on either pool's sessions.
    const locks = await first<{ n: string | number }>`select count(*) as n from pg_locks where locktype = 'advisory'`
    expect(Number(locks.rows[0].n)).toBe(0)
  })

  it('holds a plugin to its hourly limits when two instances accept its email at once', async () => {
    await first`delete from mail_counters`
    const reserve = (db: DbClient, recipient: { address: string }) =>
      db.transaction((tx) => reserveRecipientSlot(tx, 'acme.pg', recipient)).then(
        () => 'taken',
        (err: unknown) => (err instanceof MailLimitError ? 'refused' : `error: ${String(err)}`),
      )
    // One address: twenty an hour, whichever instance is asked.
    const sameAddress = await Promise.all(
      Array.from({ length: 80 }, (_unused, index) => reserve(index % 2 ? first : second, { address: 'one@example.com' })),
    )
    expect(sameAddress.filter((result) => result === 'taken')).toHaveLength(MAIL_PER_RECIPIENT_HOURLY_LIMIT)
    expect(sameAddress.filter((result) => result === 'refused')).toHaveLength(80 - MAIL_PER_RECIPIENT_HOURLY_LIMIT)

    // Many addresses: two hundred an hour for the plugin in all.
    const manyAddresses = await Promise.all(
      Array.from({ length: 300 }, (_unused, index) => reserve(index % 2 ? first : second, { address: `p${index}@example.com` })),
    )
    const room = MAIL_EXTERNAL_HOURLY_LIMIT - MAIL_PER_RECIPIENT_HOURLY_LIMIT
    expect(manyAddresses.filter((result) => result === 'taken')).toHaveLength(room)
    expect(manyAddresses.filter((result) => result === 'refused')).toHaveLength(300 - room)
  })

  it('lets a second instance drain what the first one queued', async () => {
    await queueTemplateMail(first, { key: 'queue.pg', to: 'later@example.com', variables: {} })
    const sent: string[] = []
    await drainMailQueue(second, { carrier: async (_c, _s, mail) => { sent.push(mail.to); return null }, now: () => Date.now() + 5_000, paceMs: 0 })
    expect(sent).toEqual(['later@example.com'])
  })
})
