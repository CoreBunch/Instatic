import type { AuthUser } from '../../repositories/users'
import { canvasModules, canvasCollections } from '../../canvas/catalog'
import { canReadTable, hasContentRowAccess } from '../../auth/dataAccess'
import { getBranch } from '../../repositories/branches'
import { renderBranchPreview } from '../../publish/branchPreview'
import { Type } from '@sinclair/typebox'
import { readEnvelope } from '@core/http'
import { isGeneratedClassLocked, type Page } from '@core/page-tree'
import { canActOnBranch, isMainBranch, BRANCH_HEADER } from '@core/branches'
import { composedNodeSourceId } from '@core/templates'
import { requireCapability } from '../../auth/authz'
import { canvasRevision } from '../../canvas/revision'
import type { BranchScope } from '../../branches/scope'
import type { DbClient } from '../../db/client'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { listDataTablesWithCounts, listDataRowSeqs, getDataRowBySlug } from '../../repositories/data'
import { getDraftSiteSeq } from '../../repositories/site'
import { runPublishFlush } from '../../publish/publishFlush'
import { getDraftSiteDocument } from '../../repositories/publish'
import { composeReviewPage, renderReviewDocument } from '../../publish/branchReviewRender'
import { readDraftPage, readDraftPages } from '../../serviceAccounts/draftPage'
import { saveSiteDocument, SITE_WRITE_CAPABILITIES } from './siteDocument'
import { applyCanvasEdit, CanvasEditSchema } from '../../canvas/edit'

const CanvasSave = Type.Object({ pages: Type.Array(Type.Object({
  id: Type.String(), slug: Type.String(), rootNodeId: Type.String(), revision: Type.String(),
}), { minItems: 1 }) })

async function inspectRevision(db: DbClient, scope: BranchScope, pageId: string) {
  const [rows, shell] = await Promise.all([listDataRowSeqs(db, scope, 'pages', [pageId]), getDraftSiteSeq(db, scope)])
  return canvasRevision(scope.branchId, pageId, rows[0]?.seq, shell)
}

async function visitBranch(db: DbClient, scope: BranchScope, user: AuthUser, url: URL) {
  if (isMainBranch(scope.branchId)) return badRequest('Choose a review branch to visit its draft')
  const branch = await getBranch(db, scope.branchId)
  if (!branch || !canActOnBranch(user, branch)) return jsonResponse({ error: 'Branch preview permission required' }, { status: 403 })
  const path = url.searchParams.get('path')
  if (!path?.startsWith('/') || path.startsWith('//') || path.includes('\\')) return badRequest('Expected a public site path')
  let target: URL
  try {
    target = new URL(path, url.origin)
    decodeURIComponent(target.pathname)
  } catch { return badRequest('Invalid public site path') }
  if (target.origin !== url.origin || /^\/(admin|_instatic)(\/|$)/.test(target.pathname)) return badRequest('Expected a public site path')
  await runPublishFlush()
  const page = await renderBranchPreview(db, scope.branchId, target, 'signed-out')
  if (page && !page.ok) return page
  return page ? jsonResponse({ html: await page.text() }, { headers: { 'Cache-Control': 'private, no-store' } }) : jsonResponse({ error: 'Branch route not found' }, { status: 404 })
}

async function readCatalog(db: DbClient, scope: BranchScope, user: AuthUser, params: URLSearchParams) {
  if (params.has('table') || params.has('collections') || params.has('search')) {
    const tables = await listDataTablesWithCounts(db, scope)
    const visible = tables.filter(table => hasContentRowAccess(user) || canReadTable(user, table))
    const result = canvasCollections(visible, params.get('table'), params.get('search') ?? '')
    return result ? jsonResponse(result) : jsonResponse({ error: 'Collection not found' }, { status: 404 })
  }
  const modules = canvasModules(params.get('module'))
  return modules ? jsonResponse(modules) : jsonResponse({ error: 'Module not found' }, { status: 404 })
}

export async function handleCanvas(req: Request, db: DbClient, scope: BranchScope) {
  const url = new URL(req.url)
  const match = /^\/admin\/api\/cms\/canvas\/pages\/([^/]+)$/.exec(url.pathname)
  const batch = url.pathname === '/admin/api/cms/canvas/pages'
  const catalog = url.pathname === '/admin/api/cms/canvas/catalog'
  const visitor = url.pathname === '/admin/api/cms/canvas/visitor'
  if (!match && !batch && !catalog && !visitor) return null
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if ((catalog || visitor) && req.method !== 'GET') return methodNotAllowed()
  if (visitor) return visitBranch(db, scope, user, url)
  if (catalog) return readCatalog(db, scope, user, url.searchParams)
  if (!match) {
    if (req.method !== 'GET') return methodNotAllowed()
    const refs = url.searchParams.getAll('ref')
    if (!refs.length || refs.length > 100) return badRequest('Specify 1 to 100 page IDs or /slugs')
    const document = await readDraftPages(db, scope, refs)
    if (!document) return jsonResponse({ error: 'Page not found' }, { status: 404 })
    return jsonResponse({ document, pages: document.changedPages.map(({ id, slug, rootNodeId, access }) => ({
      id, slug, rootNodeId, access: access ?? { level: 'public' },
      revision: canvasRevision(scope.branchId, id, document.baseSeqs[id], document.shellBaseSeq),
    })) })
  }
  if (!['GET', 'PATCH'].includes(req.method)) return methodNotAllowed()
  let id: string
  try { id = decodeURIComponent(match[1]) } catch { return badRequest('Invalid page ID') }
  if (id.startsWith('/')) {
    const row = await getDataRowBySlug(db, scope, 'pages', id.slice(1) || 'index')
    if (!row) return jsonResponse({ error: 'Page not found' }, { status: 404 })
    id = row.id
  }
  if (req.method === 'PATCH') {
    if (!req.headers.get(BRANCH_HEADER)?.trim()) return badRequest('Choose an explicit branch for canvas edits')
    if (!SITE_WRITE_CAPABILITIES.some(cap => user.capabilities.includes(cap))) return jsonResponse({ error: 'Missing site edit permission' }, { status: 403 })
    const draft = await readDraftPage(db, scope, id)
    if (!draft) return jsonResponse({ error: 'Page not found' }, { status: 404 })
    const revision = canvasRevision(scope.branchId, id, draft.baseSeqs[id], draft.shellBaseSeq)
    const body = await readValidatedBody(req, CanvasEditSchema)
    if (!body) return badRequest('Invalid canvas edits. Use api describe PATCH canvas/pages/:id for supported operations.')
    if (revision !== body.revision) return jsonResponse({ error: 'Page or site styles changed. Inspect this branch again before editing.' }, { status: 409 })
    let changes
    try { changes = body.edits.map(edit => applyCanvasEdit(draft.changedPages[0], draft.site, edit)) }
    catch (err) { return badRequest(err instanceof Error ? err.message : 'Invalid canvas edit') }
    const saved = await saveSiteDocument(db, scope, user, draft, true)
    if (!saved.ok) return saved
    const result = await readEnvelope(saved, CanvasSave, 'Invalid canvas save response')
    return jsonResponse({ ...result.pages[0], changes })
  }
  const width = Number(url.searchParams.get('width') ?? 1280), height = Number(url.searchParams.get('height') ?? 800)
  if (![width, height].every(n => Number.isInteger(n) && n >= 10 && n <= 4096)) return badRequest('Invalid viewport dimensions')
  await runPublishFlush()
  const revision = await inspectRevision(db, scope, id)
  const site = await getDraftSiteDocument(db, scope)
  const page = site?.pages.find(p => p.id === id)
  if (!site || !page) return jsonResponse({ error: 'Page not found' }, { status: 404 })
  const { composed, templated } = composeReviewPage(site, page)
  const nodes = Object.values(composed.nodes).map(n => {
    const source = templated ? composedNodeSourceId(n.id) : n.id
    const editable = (!templated || source !== n.id) && Object.hasOwn(page.nodes, source)
    return { uid: n.id, node: editable ? source : null, module: n.moduleId, classes: n.classIds, inline: n.inlineStyles }
  })
  const references = new Map<string, { pages: string[], components: string[] }>()
  for (const n of nodes) {
    for (const id of n.classes ?? []) references.set(id, { pages: [], components: [] })
  }
  const collect = (id: string, entries: Page['nodes'], kind: 'pages' | 'components') => {
    const used = new Set(Object.values(entries).flatMap(n => n.classIds ?? []))
    for (const ruleId of used) references.get(ruleId)?.[kind].push(id)
  }
  for (const p of site.pages) collect(p.id, p.nodes, 'pages')
  for (const c of site.visualComponents) collect(c.id, c.tree.nodes, 'components')
  const rules = Object.values(site.styleRules).filter(rule => references.has(rule.id)).map(rule => ({
    id: rule.id, selector: rule.selector, editable: !rule.rawCss && !isGeneratedClassLocked(rule),
    styles: rule.styles, priorities: rule.stylePriorities, contexts: rule.contextStyles,
    contextPriorities: rule.contextStylePriorities, ...references.get(rule.id),
  }))
  const html = await renderReviewDocument(db, scope, site, page, composed, { width, height })
  if (revision !== await inspectRevision(db, scope, id)) {
    return jsonResponse({ error: 'Page or site styles changed during inspection. Inspect again.' }, { status: 409 })
  }
  return jsonResponse({ id, slug: page.slug, access: page.access ?? { level: 'public' }, revision, html, nodes, rules, contexts: [...site.breakpoints, ...(site.conditions ?? [])] })
}
