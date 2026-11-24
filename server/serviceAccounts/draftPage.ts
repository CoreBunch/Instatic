import { pageFromRow } from '@core/data/pageFromRow'
import { requireCapability } from '../auth/authz'
import type { BranchScope } from '../branches/scope'
import type { DbClient } from '../db/client'
import { getDataRow } from '../repositories/data'
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
  await runPublishFlush()
  return db.transaction(async tx => {
    // Read the sequence first: a concurrent shell update can then only produce a conflict.
    const shellBaseSeq = await getDraftSiteSeq(tx, scope)
    const site = await getDraftSite(tx, scope)
    const row = await getDataRow(tx, scope, pageId)
    if (!site || row?.tableId !== 'pages') return null
    return { mode: 'incremental' as const, site, shellBaseSeq, baseSeqs: { [row.id]: row.seq ?? 0 },
      changedPages: [pageFromRow(row)], deletedPageIds: [], changedComponents: [], deletedComponentIds: [],
      changedLayouts: [], deletedLayoutIds: [] }
  })
}
