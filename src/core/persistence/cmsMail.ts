/**
 * Client for the outgoing mail settings (`server/handlers/cms/mail.ts`).
 * Every response is validated against the shared `@core/mail` schemas.
 */
import { apiRequest } from '@core/http'
import {
  MailOutboxResponseSchema,
  MailSettingsResponseSchema,
  MailTestResponseSchema,
  type MailOutboxEntry,
  type MailOutboxStatus,
  type MailSettingsInput,
  type MailSettingsView,
} from '@core/mail'

const MAIL_PATH = '/admin/api/cms/mail'

export async function getCmsMailSettings(signal?: AbortSignal): Promise<MailSettingsView> {
  const body = await apiRequest(`${MAIL_PATH}/settings`, {
    schema: MailSettingsResponseSchema,
    signal,
    fallbackMessage: 'Could not load the email settings',
  })
  return body.settings
}

export async function saveCmsMailSettings(input: MailSettingsInput): Promise<MailSettingsView> {
  const body = await apiRequest(`${MAIL_PATH}/settings`, {
    method: 'PUT',
    body: input,
    schema: MailSettingsResponseSchema,
    fallbackMessage: 'Could not save the email settings',
  })
  return body.settings
}

export async function deleteCmsMailSettings(): Promise<MailSettingsView> {
  const body = await apiRequest(`${MAIL_PATH}/settings`, {
    method: 'DELETE',
    schema: MailSettingsResponseSchema,
    fallbackMessage: 'Could not remove the email account',
  })
  return body.settings
}

export async function sendCmsTestMail(to: string): Promise<MailOutboxStatus> {
  const body = await apiRequest(`${MAIL_PATH}/test`, {
    method: 'POST',
    body: { to },
    schema: MailTestResponseSchema,
    fallbackMessage: 'The test email could not be sent',
  })
  return body.status
}

export async function listCmsMailOutbox(signal?: AbortSignal): Promise<MailOutboxEntry[]> {
  const body = await apiRequest(`${MAIL_PATH}/outbox`, {
    schema: MailOutboxResponseSchema,
    signal,
    fallbackMessage: 'Could not load the delivery log',
  })
  return body.entries
}
