import {
  ApplyMergeBodySchema, CreateBranchBodySchema, CreateMergeRequestBodySchema, CreateReviewCommentBodySchema,
  DeclineMergeRequestBodySchema, RenameBranchBodySchema,
} from '@core/branches'
import { PageSchema, SiteShellSchema } from '@core/page-tree'
import { VisualComponentSchema } from '@core/visualComponents'
import { SitePackageJsonSchema } from '@core/site-dependencies/manifest'
import { SiteDocumentBodySchema } from '@core/persistence/siteDocumentBody'
import { Type } from '@core/utils/typeboxHelpers'
import { LoopSourcePreviewRequestSchema } from '@core/loops'
import { RuntimeDependencyBodySchema, RuntimePreviewBodySchema, RuntimeValidationBodySchema } from '../../handlers/cms/runtime'
import { GoogleFontSelectionBodySchema, CustomFontBodySchema } from '../../handlers/cms/fonts'
import { SITE_WRITE_CAPABILITIES } from '../../handlers/cms/siteDocument'
import { SearchQuerySchema } from '../../handlers/cms/registry'
import { CanvasEditSchema } from '../../canvas/edit'
import { operation as op } from './operation'

const read = 'site.read'
const manage = 'site.branches.manage'
const ownBranch = ['site.branches.create', manage] as const
const styles = 'site.style.edit'
const name = 'URL-encode the package name, including the slash in scoped names.'
// These envelopes accept loose input at the HTTP boundary and validate the nested
// document in the handler. Describe the canonical shapes accepted by that second pass.
const runtimeSite = Type.Composite([SiteShellSchema, Type.Object({
  pages: Type.Optional(Type.Array(PageSchema)), visualComponents: Type.Optional(Type.Array(VisualComponentSchema)),
})])
export const siteOperations = [
  op('GET', 'public-site', [], 'Read the public site identity'),
  op('GET', 'cli-context', [], 'Read the effective grant and available operations', { querySchema: Type.Object({ guide: Type.Optional(Type.Literal('membership')), describe: Type.Optional(Type.String({ description: 'METHOD path template from lookup' })) }) }),
  op('GET', 'site', read, 'Read the site shell and its sequence'),
  op('GET', 'pages', read, 'List page rows'),
  op('GET', 'layouts', read, 'List saved layouts'),
  op('GET', 'components', read, 'List visual components'),
  op('GET', 'canvas/catalog', read, 'Discover canvas modules, property schemas, collection fields, row bindings and an editable listing example for your table.', { querySchema: Type.Partial(Type.Object({
    module: Type.String({ description: 'Module ID for full props and defaults' }), table: Type.String({ description: 'Table ID or slug for a bound listing example' }),
    collections: Type.String({ description: 'List visible tables and loop sources' }), search: Type.String({ description: 'Find a named table, e.g. list events' }),
  })) }),
  op('GET', 'canvas/visitor', [[read], ownBranch], 'Render a visitor route on your review branch with its runtime scripts. Use instatic visit PATH --branch BRANCH.', { querySchema: Type.Object({ path: Type.String({ description: 'Public path with optional query, including an entry permalink' }) }) }),
  op('GET', 'canvas/pages', read, 'Read editable pages and revisions in one snapshot. Repeat ref for each ID or /slug.', { querySchema: Type.Object({ ref: Type.Array(Type.String(), { minItems: 1, maxItems: 100, description: 'Repeated query parameter, e.g. ?ref=/&ref=/login' }) }) }),
  op('GET', 'canvas/pages/:id', read, 'Inspect the rendered canvas, editable nodes, shared styles and revision. Use instatic canvas inspect for a PNG and layout measurements.', { querySchema: Type.Partial(Type.Object({ width: Type.Integer({ minimum: 10, maximum: 4096 }), height: Type.Integer({ minimum: 10, maximum: 4096 }) })) }),
  op('PATCH', 'canvas/pages/:id', [[read], SITE_WRITE_CAPABILITIES], 'Apply targeted canvas edits atomically with an explicit --branch and the inspected revision. Rule edits affect the shared selector.', { bodySchema: CanvasEditSchema, example: { revision: 'FROM_INSPECT', edits: [{ op: 'text', node: 'NODE_ID', value: 'New heading' }] } }),
  op('GET', 'draft-page/:id', read, 'Read an editable page payload with base sequences'),
  op('PUT', 'site-document', SITE_WRITE_CAPABILITIES, 'Save a document with an explicit --branch. Use the document from canvas read and retain its base sequences. The response includes a revision per saved page. The CMS checks permissions for each change.', { bodySchema: Type.Object({ ...SiteDocumentBodySchema.properties, site: SiteShellSchema, changedPages: Type.Array(PageSchema) }, { additionalProperties: false }) }),
  op('GET', 'branches', read, 'List branch IDs and names'),
  op('POST', 'branches', 'site.branches.create', 'Fork a branch from main or fromBranchId', { bodySchema: CreateBranchBodySchema, example: { name: 'review' } }),
  op('PATCH', 'branches/:id', ownBranch, 'Rename your branch, or any branch with branch management', { bodySchema: RenameBranchBodySchema }),
  op('DELETE', 'branches/:id', ownBranch, 'Delete your branch, or any branch with branch management'),
  op('GET', 'branches/:id/preview', read, 'Read branch preview-link status'),
  op('POST', 'branches/:id/preview', ownBranch, 'Issue a preview link for a branch you can manage'),
  op('DELETE', 'branches/:id/preview', ownBranch, 'Revoke the branch preview link'),
  op('GET', 'branches/:id/merge', read, 'Inspect the merge plan and conflicts'),
  op('POST', 'branches/:id/merge', manage, 'Merge into main using the current plan', { bodySchema: ApplyMergeBodySchema }),
  op('POST', 'branches/:id/merge/undo', manage, 'Undo the latest merge'),
  op('GET', 'branches/:id/update', read, 'Plan an update from main'),
  op('POST', 'branches/:id/update', ownBranch, 'Update the branch from main using the current plan', { bodySchema: ApplyMergeBodySchema }),
  op('POST', 'branches/:id/update/undo', ownBranch, 'Undo the latest branch update'),
  op('GET', 'branches/:id/review', read, 'Read the merge request and review comments'),
  op('POST', 'branches/:id/review/request', read, 'Request review of a branch', { bodySchema: CreateMergeRequestBodySchema }),
  op('POST', 'branches/:id/review/withdraw', read, 'Withdraw your review request, or any request with branch management'),
  op('POST', 'branches/:id/review/decline', manage, 'Decline a review request', { bodySchema: DeclineMergeRequestBodySchema }),
  op('POST', 'branches/:id/review/comments', read, 'Comment on a branch review', { bodySchema: CreateReviewCommentBodySchema }),
  op('GET', 'branches/:id/review/render', read, 'Render a page for review. Use instatic screenshot to capture it.', { querySchema: Type.Object({
    row: Type.String({ description: 'Page row ID' }), side: Type.Union([Type.Literal('branch'), Type.Literal('main')]),
    width: Type.Optional(Type.Integer({ minimum: 10, maximum: 4096 })), height: Type.Optional(Type.Integer({ minimum: 10, maximum: 4096 })),
  }) }),
  op('GET', 'publish/status', read, 'Check whether the draft differs from the published site'),
  op('POST', 'publish', 'pages.publish', 'Publish main after merging any branch changes'),
  op('GET', 'runtime/canvas-stylesheets', read, 'List stylesheets for the canvas'),
  op('POST', 'runtime/dependencies/resolve', 'runtime.dependencies', 'Resolve dependencies from packageJson.dependencies', { bodySchema: Type.Object({ ...RuntimeDependencyBodySchema.properties, packageJson: Type.Partial(SitePackageJsonSchema) }), example: { packageJson: { dependencies: {} } } }),
  op('POST', 'runtime/validate', read, 'Compile scripts for a site document including pages and visualComponents', { bodySchema: Type.Object({ ...RuntimeValidationBodySchema.properties, site: runtimeSite }) }),
  op('POST', 'runtime/preview', read, 'Render one page of the supplied site document', { bodySchema: Type.Object({ ...RuntimePreviewBodySchema.properties, site: runtimeSite }) }),
  op('GET', 'registry', read, 'Read the package registry profile'),
  op('GET', 'registry/search', read, 'Search registry packages', { querySchema: Type.Object({
    ...Type.Partial(SearchQuerySchema).properties, q: SearchQuerySchema.properties.q,
  }) }),
  op('GET', 'registry/packages/:name', read, 'Read package details. ' + name),
  op('GET', 'registry/packages/:name/latest', read, 'Read the latest version. ' + name),
  op('GET', 'registry/packages/:name/downloads', read, 'Read download statistics. ' + name),
  op('GET', 'registry/packages/:name/advisories', read, 'Read advisories for a package version. ' + name, { querySchema: Type.Object({ version: Type.String() }) }),
  op('GET', 'loop-sources', read, 'List registered plugin loop sources'),
  op('POST', 'loop-sources/preview', read, 'Preview a registered loop source', { bodySchema: LoopSourcePreviewRequestSchema }),
  op('GET', 'fonts/google', styles, 'List Google font families'),
  op('POST', 'fonts/estimate', styles, 'Estimate download size for the selected font variants and subsets', { bodySchema: GoogleFontSelectionBodySchema }),
  op('POST', 'fonts/install', styles, 'Install selected Google font variants and subsets', { bodySchema: GoogleFontSelectionBodySchema }),
  op('POST', 'fonts/custom', styles, 'Install a font from uploaded media assets', { bodySchema: CustomFontBodySchema }),
  op('DELETE', 'fonts/family/:family', styles, 'Remove an installed font family'),
]
