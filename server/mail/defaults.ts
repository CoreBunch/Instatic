/**
 * Mail defaults — the one `mail_settings` row: which connector sends, and
 * the sender every email carries.
 */
import type { DbClient } from '../db/client'
import type { MailDefaults } from '@core/mail'
import { nowIso } from '@core/utils/isoDate'

const SETTINGS_ROW_ID = 'default'

const EMPTY_DEFAULTS: MailDefaults = { defaultConnectorId: null, fromAddress: '', fromName: '', replyTo: '' }

export async function getMailDefaults(db: DbClient): Promise<MailDefaults> {
  const { rows } = await db<{
    default_connector_id: string | null
    from_address: string
    from_name: string
    reply_to: string
  }>`
    select default_connector_id, from_address, from_name, reply_to
      from mail_settings where id = ${SETTINGS_ROW_ID}
  `
  const row = rows[0]
  if (!row) return EMPTY_DEFAULTS
  return {
    defaultConnectorId: row.default_connector_id,
    fromAddress: row.from_address,
    fromName: row.from_name,
    replyTo: row.reply_to,
  }
}

export async function saveMailDefaults(db: DbClient, defaults: MailDefaults, actorUserId: string): Promise<void> {
  await db`
    insert into mail_settings (id, default_connector_id, from_address, from_name, reply_to, updated_by_user_id, updated_at)
    values (
      ${SETTINGS_ROW_ID}, ${defaults.defaultConnectorId}, ${defaults.fromAddress}, ${defaults.fromName.trim()},
      ${defaults.replyTo}, ${actorUserId}, ${nowIso()}
    )
    on conflict (id) do update set
      default_connector_id = excluded.default_connector_id,
      from_address = excluded.from_address,
      from_name = excluded.from_name,
      reply_to = excluded.reply_to,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at
  `
}
