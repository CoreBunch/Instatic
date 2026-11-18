/**
 * Client for the Email workspace API (`server/handlers/cms/mail.ts`).
 * Every response is validated against the shared `@core/mail` schemas.
 */
import { apiRequest } from '@core/http'
import {
  MailActivityResponseSchema,
  MailConnectorResponseSchema,
  MailOverviewResponseSchema,
  MailTemplateResponseSchema,
  MailTemplatesResponseSchema,
  MailTestResponseSchema,
  type MailActivityPeriod,
  type MailActivityResponse,
  type MailActivityStatus,
  type MailConnector,
  type MailConnectorInput,
  type MailDefaults,
  type MailOverview,
  type MailTemplate,
  type MailTemplateInput,
} from '@core/mail'

const MAIL_PATH = '/admin/api/cms/mail'

export async function getCmsMailOverview(signal?: AbortSignal): Promise<MailOverview> {
  const body = await apiRequest(MAIL_PATH, {
    schema: MailOverviewResponseSchema,
    signal,
    fallbackMessage: 'Could not load the email settings',
  })
  return body.overview
}

export async function createCmsMailConnector(input: MailConnectorInput): Promise<MailConnector> {
  const body = await apiRequest(`${MAIL_PATH}/connectors`, {
    method: 'POST',
    body: input,
    schema: MailConnectorResponseSchema,
    fallbackMessage: 'Could not add the connector',
  })
  return body.connector
}

export async function deleteCmsMailConnector(id: string): Promise<MailOverview> {
  const body = await apiRequest(`${MAIL_PATH}/connectors/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    schema: MailOverviewResponseSchema,
    fallbackMessage: 'Could not remove the connector',
  })
  return body.overview
}

export async function setCmsMailConnectorSecret(id: string, secret: string): Promise<MailConnector> {
  const body = await apiRequest(`${MAIL_PATH}/connectors/${encodeURIComponent(id)}/secret`, {
    method: 'PUT',
    body: { secret },
    schema: MailConnectorResponseSchema,
    fallbackMessage: 'Could not save the secret',
  })
  return body.connector
}

export async function testCmsMailConnector(id: string, to: string): Promise<MailActivityStatus> {
  const body = await apiRequest(`${MAIL_PATH}/connectors/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: { to },
    schema: MailTestResponseSchema,
    fallbackMessage: 'The test email could not be sent',
  })
  return body.status
}

export async function saveCmsMailDefaults(defaults: MailDefaults): Promise<MailOverview> {
  const body = await apiRequest(`${MAIL_PATH}/defaults`, {
    method: 'PUT',
    body: defaults,
    schema: MailOverviewResponseSchema,
    fallbackMessage: 'Could not save the defaults',
  })
  return body.overview
}

export async function listCmsMailTemplates(signal?: AbortSignal): Promise<MailTemplate[]> {
  const body = await apiRequest(`${MAIL_PATH}/templates`, {
    schema: MailTemplatesResponseSchema,
    signal,
    fallbackMessage: 'Could not load the email templates',
  })
  return body.templates
}

export async function saveCmsMailTemplate(key: string, input: MailTemplateInput): Promise<MailTemplate> {
  const body = await apiRequest(`${MAIL_PATH}/templates/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: input,
    schema: MailTemplateResponseSchema,
    fallbackMessage: 'Could not save the template',
  })
  return body.template
}

export async function resetCmsMailTemplate(key: string): Promise<MailTemplate> {
  const body = await apiRequest(`${MAIL_PATH}/templates/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    schema: MailTemplateResponseSchema,
    fallbackMessage: 'Could not reset the template',
  })
  return body.template
}

export async function testCmsMailTemplate(key: string, to: string): Promise<MailActivityStatus> {
  const body = await apiRequest(`${MAIL_PATH}/templates/${encodeURIComponent(key)}/test`, {
    method: 'POST',
    body: { to },
    schema: MailTestResponseSchema,
    fallbackMessage: 'The test email could not be sent',
  })
  return body.status
}

export interface CmsMailActivityQuery {
  period: MailActivityPeriod
  status: MailActivityStatus | null
  kind: string | null
  connector: string | null
  search: string
  /** The id of the last entry already shown, to read the next page. */
  before?: string
}

export async function getCmsMailActivity(
  query: CmsMailActivityQuery,
  signal?: AbortSignal,
): Promise<MailActivityResponse> {
  return apiRequest(`${MAIL_PATH}/activity`, {
    query: {
      period: query.period,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.connector ? { connector: query.connector } : {}),
      ...(query.search.trim() ? { q: query.search.trim() } : {}),
      ...(query.before ? { before: query.before } : {}),
    },
    schema: MailActivityResponseSchema,
    signal,
    fallbackMessage: 'Could not load the activity',
  })
}
