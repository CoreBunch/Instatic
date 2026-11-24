import { pageFromRow } from '@core/data/pageFromRow'
import { requireCapability } from '../auth/authz'
import type { BranchScope } from '../branches/scope'
import type { DbClient } from '../db/client'
import { getDataRow, getDataRowBySlug } from '../repositories/data'
import { getDraftSite, getDraftSiteSeq } from '../repositories/site'
import { runPublishFlush } from '../publish/publishFlush'
import { jsonResponse, methodNotAllowed } from '../http'

export async function handleDraftPage(req: Request, db: DbClient, scope: BranchScope) {
  const match = /^\/admin\/api\/cms\/draft-page\/([^/]+)$/.exec(new URL(req.url).pathname)
  if (!match) return null
  if (req.method !== 'GET') return methodNotAllowed()
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  let pageId: string
  try {
    pageId = decodeURIComponent(match[1])
  } catch {
    return jsonResponse({ error: 'Invalid page ID' }, { status: 400 })
  }
  const draft = await readDraftPage(db, scope, pageId)
  return draft ? jsonResponse(draft) : jsonResponse({ error: 'Page not found' }, { status: 404 })
}

export async function readDraftPage(db: DbClient, scope: BranchScope, pageId: string) {
  return readDraftPages(db, scope, [pageId])
}

export async function readDraftPages(db: DbClient, scope: BranchScope, refs: string[]) {
  await runPublishFlush()
  return db.transaction(async tx => {
    const shellBaseSeq = await getDraftSiteSeq(tx, scope)
    const site = await getDraftSite(tx, scope)
    if (!site) return null
    const pages = []
    const baseSeqs: Record<string, number> = Object.create(null)
    for (const ref of refs) {
      const row = ref.startsWith('/')
        ? await getDataRowBySlug(tx, scope, 'pages', ref.slice(1) || 'index')
        : await getDataRow(tx, scope, ref)
      if (row?.tableId !== 'pages') return null
      if (Object.hasOwn(baseSeqs, row.id)) continue
      pages.push(pageFromRow(row))
      baseSeqs[row.id] = row.seq ?? 0
    }
    return { mode: 'incremental' as const, site, shellBaseSeq, baseSeqs,
      changedPages: pages, deletedPageIds: [], changedComponents: [], deletedComponentIds: [],
      changedLayouts: [], deletedLayoutIds: [] }
  })
}
