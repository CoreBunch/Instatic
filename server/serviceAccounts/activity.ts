import { randomUUID } from 'node:crypto'
import type { ServiceActivity } from '@core/serviceAccounts'
import type { DbClient } from '../db/client'
import { requireCapability } from '../auth/authz'
import { servicePrincipal } from '../auth/servicePrincipal'
import { jsonResponse, methodNotAllowed } from '../http'
import { cmsOperations } from './catalog'

// Only persist catalog templates, never request bodies, arbitrary plugin URLs,
// query strings, or rendered content. Status distinguishes attempted and successful work.
const routes = cmsOperations.map(op => ({ method: op.method, path: op.path, parts: op.path.split('/') }))
const titles: Record<string, string> = {
  'GET canvas/pages': 'Read canvas pages', 'GET canvas/pages/:id': 'Inspected a page',
  'PATCH canvas/pages/:id': 'Edited a page', 'GET canvas/visitor': 'Previewed a visitor route',
  'GET canvas/catalog': 'Inspected canvas modules', 'PUT site-document': 'Saved site changes',
  'POST branches': 'Created a branch', 'GET branches/:id/merge': 'Compared branch changes',
  'GET branches/:id/review': 'Read the branch review', 'POST branches/:id/review/comments': 'Commented on the review',
  'POST branches/:id/review/comments/:commentId/resolve': 'Resolved review feedback',
  'POST branches/:id/review/request': 'Requested a branch review',
}
export async function recordServiceResponse(req: Request, db: DbClient, response: Response): Promise<Response> {
  const actor = servicePrincipal(req)
  if (!actor) return response
  const path = new URL(req.url).pathname.replace(/^\/admin\/api\/cms\//, '')
  const parts = path.split('/')
  const route = routes.find(op => op.method === req.method && op.parts.length === parts.length &&
    op.parts.every((part, i) => part === parts[i] || part.startsWith(':')))
  const operation = route ? req.method + ' ' + route.path : req.method + ' CMS operation'
  const title = response.ok ? titles[operation] ?? operation : operation
  const scope = req.headers.get('X-Instatic-Branch') ?? (parts[0] === 'branches' ? parts[1] : null) ?? null
  try {
    await db.transaction(async tx => {
      await tx`insert into service_account_activity (id, account_id, title, scope, http_status, occurred_at)
        values (${randomUUID()}, ${actor.user.id}, ${title}, ${scope?.slice(0,100) ?? null}, ${response.status}, ${new Date().toISOString()})`
      await tx`delete from service_account_activity where account_id = ${actor.user.id}
        and id not in (select id from service_account_activity where account_id = ${actor.user.id}
          order by occurred_at desc, id desc limit 100)`
    })
  } catch (err) {
    // Telemetry failure must not turn a committed CMS edit into a retryable response.
    console.error('[service-activity]', err)
  }
  return response
}

const lifecycle: Record<string, string> = {
  'service_account.created': 'Connection created', 'service_account.authorized': 'Access approved',
  'service_account.revoked': 'Access revoked',
}
export async function handleServiceActivity(req: Request, db: DbClient): Promise<Response | null> {
  const match = /^\/admin\/api\/cms\/service-accounts\/([^/]+)\/activity$/.exec(new URL(req.url).pathname)
  if (!match) return null
  if (req.method !== 'GET') return methodNotAllowed()
  const owner = await requireCapability(req, db, 'ai.providers.manage')
  if (owner instanceof Response) return owner
  const id = match[1]
  const [calls, changes] = await Promise.all([
    db<ServiceActivity>`select e.id, a.label as agent, e.title, e.scope, e.http_status as status, e.occurred_at as at
      from service_accounts a join service_account_activity e on e.account_id = a.id
      where a.owner_id = ${owner.id} and (a.id = ${id} or a.group_run_id = ${id})
      order by e.occurred_at desc, e.id desc limit 100`,
    db<{ id: string; agent: string; action: string; at: Date | string }>`
      select e.id, a.label as agent, e.action, e.created_at as at from service_accounts a
      join audit_events e on e.target_id = a.id and e.target_type = 'service_account'
      where a.owner_id = ${owner.id} and (a.id = ${id} or a.group_run_id = ${id})
      order by e.created_at desc, e.id desc limit 100`,
  ])
  const events = [...calls.rows, ...changes.rows.map(e => ({
    id: e.id, agent: e.agent, at: new Date(e.at).toISOString(), title: lifecycle[e.action] ?? e.action, scope: null, status: null,
  }))].sort((a,b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0,100)
  return jsonResponse({ events })
}
