import { isGeneratedClassLocked, type Page } from '@core/page-tree'
import { BRANCH_HEADER } from '@core/branches'
import { composedNodeSourceId } from '@core/templates'
import { requireCapability } from '../../auth/authz'
import { contentHash } from '../../branches/contentHash'
import type { BranchScope } from '../../branches/scope'
import type { DbClient } from '../../db/client'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { listDataRowSeqs } from '../../repositories/data'
import { getDraftSiteSeq } from '../../repositories/site'
import { runPublishFlush } from '../../publish/publishFlush'
import { getDraftSiteDocument } from '../../repositories/publish'
import { composeReviewPage, renderReviewDocument } from '../../publish/branchReviewRender'
import { readDraftPage } from '../../serviceAccounts/draftPage'
import { saveSiteDocument, SITE_WRITE_CAPABILITIES } from './siteDocument'
import { applyCanvasEdit, CanvasEditSchema } from '../../canvas/edit'

async function inspectRevision(db: DbClient, scope: BranchScope, pageId: string) {
  const [rows, shell] = await Promise.all([listDataRowSeqs(db, scope, 'pages', [pageId]), getDraftSiteSeq(db, scope)])
  return contentHash([scope.branchId, pageId, rows[0]?.seq, shell])
}

export async function handleCanvas(req: Request, db: DbClient, scope: BranchScope) {
  const url = new URL(req.url)
  const match = /^\/admin\/api\/cms\/canvas\/pages\/([^/]+)$/.exec(url.pathname)
  if (!match) return null
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if (!['GET', 'PATCH'].includes(req.method)) return methodNotAllowed()
  let id: string
  try { id = decodeURIComponent(match[1]) } catch { return badRequest('Invalid page ID') }
  if (req.method === 'PATCH') {
    if (!req.headers.get(BRANCH_HEADER)?.trim()) return badRequest('Choose an explicit branch for canvas edits')
    if (!SITE_WRITE_CAPABILITIES.some(cap => user.capabilities.includes(cap))) return jsonResponse({ error: 'Missing site edit permission' }, { status: 403 })
    const draft = await readDraftPage(db, scope, id)
    if (!draft) return jsonResponse({ error: 'Page not found' }, { status: 404 })
    const revision = contentHash([scope.branchId, id, draft.baseSeqs[id], draft.shellBaseSeq])
    const body = await readValidatedBody(req, CanvasEditSchema)
    if (!body) return badRequest('Invalid canvas edits. Use api describe PATCH canvas/pages/:id for supported operations.')
    if (revision !== body.revision) return jsonResponse({ error: 'Page or site styles changed. Inspect this branch again before editing.' }, { status: 409 })
    let changes
    try { changes = body.edits.map(edit => applyCanvasEdit(draft.changedPages[0], draft.site, edit)) }
    catch (err) { return badRequest(err instanceof Error ? err.message : 'Invalid canvas edit') }
    const saved = await saveSiteDocument(db, scope, user, draft, true)
    if (!saved.ok) return saved
    return jsonResponse({ changes })
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
  return jsonResponse({ revision, html, nodes, rules, contexts: [...site.breakpoints, ...(site.conditions ?? [])] })
}
