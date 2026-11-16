/**
 * Email templates as stored: `mail_templates` holds only the templates an
 * owner has edited. Everything else comes from the catalogue in
 * `@core/mail`, so a new release's wording reaches untouched templates and
 * "reset" is simply deleting the row.
 */
import type { DbClient } from '../db/client'
import {
  getMailTemplateDefinition,
  listMailTemplateDefinitions,
  type MailTemplate,
  type MailTemplateDefinition,
  type MailTemplateInput,
} from '@core/mail'
import { nowIso } from '@core/utils/isoDate'

interface TemplateRow {
  template_key: string
  subject: string
  body_markdown: string
}

function toTemplate(definition: MailTemplateDefinition, row: TemplateRow | undefined): MailTemplate {
  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    group: definition.group,
    variables: [...definition.variables],
    subject: row?.subject ?? definition.defaultSubject,
    body: row?.body_markdown ?? definition.defaultBody,
    customised: row !== undefined,
  }
}

export async function listMailTemplates(db: DbClient): Promise<MailTemplate[]> {
  const { rows } = await db<TemplateRow>`select template_key, subject, body_markdown from mail_templates`
  const byKey = new Map(rows.map((row) => [row.template_key, row]))
  return listMailTemplateDefinitions().map((definition) => toTemplate(definition, byKey.get(definition.key)))
}

/** A template by key, with the owner's edits applied. Null for a key not in the catalogue. */
export async function getMailTemplate(db: DbClient, key: string): Promise<MailTemplate | null> {
  const definition = getMailTemplateDefinition(key)
  if (!definition) return null
  const { rows } = await db<TemplateRow>`
    select template_key, subject, body_markdown from mail_templates where template_key = ${key}
  `
  return toTemplate(definition, rows[0])
}

export async function saveMailTemplate(
  db: DbClient,
  key: string,
  input: MailTemplateInput,
  actorUserId: string,
): Promise<void> {
  await db`
    insert into mail_templates (template_key, subject, body_markdown, updated_by_user_id, updated_at)
    values (${key}, ${input.subject.trim()}, ${input.body}, ${actorUserId}, ${nowIso()})
    on conflict (template_key) do update set
      subject = excluded.subject,
      body_markdown = excluded.body_markdown,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at
  `
}

/** Back to the built-in wording. */
export async function resetMailTemplate(db: DbClient, key: string): Promise<void> {
  await db`delete from mail_templates where template_key = ${key}`
}
