import { ApplyMergeBodySchema, CreateBranchBodySchema, CreateReviewCommentBodySchema } from '@core/branches'
import { SiteDocumentBodySchema } from '@core/persistence/siteDocumentBody'
import { RowUpsertBodySchema } from '../handlers/cms/data/schemas'
import { MailConnectorInputSchema, MailDefaultsSchema, MailTemplateInputSchema } from '@core/mail'
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
  { method: 'POST', path: 'branches/:id/merge', any: ['site.branches.manage'], bodySchema: ApplyMergeBodySchema, summary: 'Merge the reviewed branch into main' },
  { method: 'POST', path: 'branches/:id/review/comments', any: ['site.read'], bodySchema: CreateReviewCommentBodySchema, summary: 'Comment on a change in a branch review' },
  { method: 'GET', path: 'branches/:id/review/render?side=branch&row=:page', any: ['site.read'], summary: 'Render the branch draft for visual review. Use instatic screenshot.' },
  { method: 'GET', path: 'components', any: ['site.read'], summary: 'List visual components on a branch' },
  { method: 'GET', path: 'layouts', any: ['site.read'], summary: 'List layouts on a branch' },
  { method: 'GET', path: 'mail', any: ['mail.manage'], summary: 'Inspect installation-wide mail settings and configured connectors' },
  { method: 'GET', path: 'mail/templates', any: ['mail.manage'], summary: 'Read effective email templates and sender wording' },
  { method: 'POST', path: 'mail/connectors', any: ['mail.manage'], bodySchema: MailConnectorInputSchema, summary: 'Create an outgoing email connector' },
  { method: 'PUT', path: 'mail/defaults', any: ['mail.manage'], bodySchema: MailDefaultsSchema, summary: 'Set the default email connector and sender' },
  { method: 'PUT', path: 'mail/templates/:key', any: ['mail.manage'], bodySchema: MailTemplateInputSchema, summary: 'Update an email template' },
  { method: 'GET', path: 'mail/activity', any: ['mail.manage'], summary: 'Inspect delivery events' },
  { method: 'GET', path: '/admin/api/ai/credentials', any: ['ai.providers.manage'], summary: 'List AI provider connections owned by this identity with secrets masked' },
  { method: 'GET', path: '/admin/api/ai/defaults', any: ['ai.chat'], summary: 'Read default AI models by workspace' },
  { method: 'PUT', path: '/admin/api/ai/defaults/:scope', any: ['ai.providers.manage'], summary: 'Set the installation-wide model for site, content, data or plugin', example: { credentialId: '<id>', modelId: '<model>' } },
  { method: 'GET', path: 'plugins/:id/settings', any: ['plugins.configure'], summary: 'Read masked plugin settings' },
  { method: 'GET', path: 'data/rows/:id', any: ['content.edit.own', 'content.edit.any', 'content.manage'], summary: 'Read a content row within your ownership policy' },
  { method: 'PATCH', path: 'data/rows/:id', bodySchema: RowUpsertBodySchema, any: ['content.edit.own', 'content.edit.any', 'content.manage'], summary: 'Edit draft cells within your ownership policy', example: { cells: { title: 'New title' } } },
  { method: 'POST', path: 'plugins/inspect-package', any: ['plugins.install'], summary: 'Inspect a ZIP with --upload FILE. Review the manifest and requested plugin permissions.' },
  { method: 'POST', path: 'plugins/package', any: ['plugins.install'], summary: 'Install or upgrade a reviewed ZIP with --upload FILE --field grantedPermissions=JSON_ARRAY. Supply the approved manifest permissions.' },
  { method: 'POST', path: 'plugins', any: ['plugins.install'], summary: 'Install a JSON manifest with --json or --file', example: { manifest: { id: 'example.demo', name: 'Demo', version: '1.0.0', apiVersion: 1, permissions: [] }, grantedPermissions: [] } },
  { method: 'DELETE', path: 'plugins/:id', any: ['plugins.install'], summary: 'Uninstall a plugin and its assets' },
  { method: 'PATCH', path: 'plugins/:id', any: ['plugins.lifecycle'], summary: 'Enable or disable a plugin', example: { enabled: true } },
  { method: 'PUT', path: 'plugins/:id/settings', any: ['plugins.configure'], summary: 'Update plugin settings' },
  { method: 'GET', path: 'dashboard/pages', any: ['dashboard.read'], summary: 'Read dashboard page statistics' },
  { method: 'GET', path: 'users', any: ['users.manage'], summary: 'List CMS users' },
  { method: 'GET', path: 'roles', any: ['users.manage'], summary: 'List CMS roles' },
  { method: 'GET', path: 'members', any: ['members.read', 'members.manage'], summary: 'List site members' },
  { method: 'GET', path: 'audit', any: ['audit.read'], summary: 'Read the CMS audit log' },
  { method: 'GET', path: '/admin/api/ai/audit', any: ['ai.audit.read'], summary: 'Read AI usage by user, scope, model and day' },
  { method: 'GET', path: 'media/storage', any: ['storage.elect'], summary: 'Inspect media storage adapters' },
  { method: 'POST', path: 'runtime/dependencies/resolve', any: ['runtime.dependencies'], summary: 'Resolve runtime dependencies' },
  { method: 'GET', path: 'publish/status', any: ['site.read'], summary: 'Check the draft against the published site' },
  { method: 'POST', path: 'publish', any: ['pages.publish'], summary: 'Publish the main site' },
  { method: 'GET', path: 'export', any: ['data.export'], summary: 'Export a site bundle. Save the response with --out FILE.' },
  { method: 'POST', path: 'import/archive', any: ['data.import'], summary: 'Import a site archive with --raw FILE. The CMS checks the selected content and import strategy.' },
  { method: 'GET', path: 'plugins', any: ['plugins.read'], summary: 'List installed plugins' },
  { method: 'GET', path: 'data/tables', any: ['data.system.tables.read','data.custom.tables.read','content.manage'], summary: 'List accessible data tables' },
  { method: 'POST', path: 'media', any: ['media.write'], summary: 'Upload an asset with --upload FILE' },
  { method: 'GET', path: 'media', any: ['media.read'], summary: 'List media assets' },
]
