import { CreateBranchBodySchema } from '@core/branches'
import { SiteDocumentBodySchema } from '@core/persistence/siteDocumentBody'
import { RowUpsertBodySchema } from '../handlers/cms/data/schemas'
import type { TSchema } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'

interface Operation {
  method: string
  path: string
  summary: string
  any: CoreCapability[]
  bodySchema?: TSchema
  example?: unknown
}
export const operations: Operation[] = [
  { method: 'GET', path: 'branches', any: ['site.read'], summary: 'List branch IDs and names' },
  { method: 'POST', path: 'branches', any: ['site.branches.create'], summary: 'Fork a branch from main or fromBranchId', bodySchema: CreateBranchBodySchema, example: { name: 'review' } },
  { method: 'GET', path: 'pages', any: ['site.read'], summary: 'List page rows. Pass --branch ID to read a draft.' },
  { method: 'GET', path: 'draft-page/:id', any: ['site.read'], summary: 'Read one page as a complete incremental save payload. Edit changedPages[0] and retain the base sequences.' },
  { method: 'PUT', path: 'site-document', bodySchema: SiteDocumentBodySchema, any: ['site.structure.edit','site.content.edit','site.style.edit'], summary: 'Save the edited draft-page payload with --branch ID --file payload.json. On 409 reread and reconcile.' },
  { method: 'GET', path: 'site', any: ['site.read'], summary: 'Read the site shell and its current sequence' },
  { method: 'GET', path: 'branches/:id/merge', any: ['site.read'], summary: 'Inspect the changes on the branch' },
  { method: 'GET', path: 'branches/:id/review/render?side=branch&row=:page', any: ['site.read'], summary: 'Render the branch draft for visual review. Use instatic screenshot.' },
  { method: 'GET', path: 'components', any: ['site.read'], summary: 'List visual components on a branch' },
  { method: 'GET', path: 'layouts', any: ['site.read'], summary: 'List layouts on a branch' },
  { method: 'GET', path: 'mail', any: ['mail.manage'], summary: 'Inspect installation-wide mail settings and configured connectors' },
  { method: 'GET', path: 'mail/templates', any: ['mail.manage'], summary: 'Read effective email templates and sender wording' },
  { method: 'GET', path: 'mail/activity', any: ['mail.manage'], summary: 'Inspect delivery events' },
  { method: 'GET', path: '/admin/api/ai/credentials', any: ['ai.providers.manage'], summary: 'List AI provider connections owned by this identity with secrets masked' },
  { method: 'GET', path: '/admin/api/ai/defaults', any: ['ai.chat'], summary: 'Read default AI models by workspace' },
  { method: 'PUT', path: '/admin/api/ai/defaults/:scope', any: ['ai.providers.manage'], summary: 'Set the installation-wide model for site, content, data or plugin', example: { credentialId: '<id>', modelId: '<model>' } },
  { method: 'GET', path: 'plugins/:id/settings', any: ['plugins.configure'], summary: 'Read masked plugin settings' },
  { method: 'GET', path: 'data/rows/:id', any: ['content.edit.own', 'content.edit.any', 'content.manage'], summary: 'Read a content row within your ownership policy' },
  { method: 'PATCH', path: 'data/rows/:id', bodySchema: RowUpsertBodySchema, any: ['content.edit.own', 'content.edit.any', 'content.manage'], summary: 'Edit draft cells within your ownership policy', example: { cells: { title: 'New title' } } },
  { method: 'GET', path: 'plugins', any: ['plugins.read'], summary: 'List installed plugins' },
  { method: 'GET', path: 'data/tables', any: ['data.system.tables.read','data.custom.tables.read','content.manage'], summary: 'List accessible data tables' },
  { method: 'POST', path: 'media', any: ['media.write'], summary: 'Upload an asset with --upload FILE' },
  { method: 'GET', path: 'media', any: ['media.read'], summary: 'List media assets' },
]
