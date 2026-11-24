import { BRANCH_HEADER } from '@core/branches'
import type { CoreCapability } from '@core/capabilities'
import { Type } from '@core/utils/typeboxHelpers'
import { canDiscover, type Operation } from './catalog/operation'
import { siteOperations } from './catalog/site'

// Each permitted handler reads its target from the verified header or review URL.
// New CMS, AI and plugin routes require a scope review before groups can call them.
const permitted = new Set([
  'GET cli-context', 'GET canvas/catalog', 'GET canvas/visitor',
  'GET canvas/pages', 'GET canvas/pages/:id', 'PATCH canvas/pages/:id',
  'GET branches/:id/merge', 'GET branches/:id/review', 'POST branches/:id/review/comments',
  'POST branches/:id/review/comments/:commentId/resolve',
  'POST branches/:id/review/request', 'POST branches/:id/review/withdraw', 'GET branches/:id/review/render',
])

const groupOperations = siteOperations.filter(op => permitted.has(op.method + ' ' + op.path)).map((op): Operation => {
  if (op.path === 'canvas/visitor') return { ...op, permissions: [['site.read']] }
  if (op.path === 'branches/:id/review/render' && op.querySchema) {
    return { ...op, querySchema: { ...op.querySchema, properties: { ...op.querySchema.properties, side: Type.Literal('branch') } } }
  }
  return op
})

export function availableGroupOperations(capabilities: readonly CoreCapability[]) {
  return groupOperations.filter(op => canDiscover(op, capabilities)).flatMap(op => op.method === 'GET'
    ? [op, { ...op, method: 'HEAD', summary: 'Read response headers. ' + op.summary }]
    : [op])
}

export function permitsGroupRequest(req: Request, branchId: string, capabilities: readonly CoreCapability[]) {
  const url = new URL(req.url)
  const prefix = '/admin/api/cms/'
  if (!url.pathname.startsWith(prefix)) return false
  const path = url.pathname.slice(prefix.length)
  const header = req.headers.get(BRANCH_HEADER)
  if (path === 'cli-context') return req.method === 'GET' && (header === null || header === branchId)
  if (header !== branchId) return false
  const parts = path.split('/')
  if (parts[0] === 'branches') {
    if (parts[1] !== branchId) return false
    parts[1] = ':id'
    if (parts[2] === 'review' && parts[3] === 'comments' && parts.length === 6 && parts[4]) parts[4] = ':commentId'
  } else if (parts[0] === 'canvas' && parts[1] === 'pages' && parts.length === 3 && parts[2]) {
    parts[2] = ':id'
  }
  const template = parts.join('/')
  if (template === 'branches/:id/review/render' && url.searchParams.get('side') !== 'branch') return false
  return groupOperations.some(op => op.method === req.method && op.path === template && canDiscover(op, capabilities))
}
