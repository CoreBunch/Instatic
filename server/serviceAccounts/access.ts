import type { DbClient } from '../db/client'
import { jsonResponse } from '../http'
import { resolveServiceActor } from './store'
import { bindServicePrincipal } from '../auth/servicePrincipal'
import { operations } from './catalog'

const CMS_GROUPS = new Set([
  'branches', 'pages', 'site', 'components', 'layouts', 'site-document', 'draft-page',
  'mail', 'plugins', 'media', 'data', 'cli-context',
])
const AI_GROUPS = new Set(['credentials', 'defaults', 'providers'])

export function tryAuthorizeServiceRequest(req: Request, db: DbClient): Promise<Request | Response> | null {
  const match = /^Bearer\s+(icli_\S+)$/i.exec(req.headers.get('authorization') ?? '')
  return match ? authorize(req, db, match[1]) : null
}

async function authorize(req: Request, db: DbClient, token: string): Promise<Request | Response> {
  const pathname = new URL(req.url).pathname
  const [, , , namespace, group] = pathname.split('/')
  const supported = namespace === 'cms' ? CMS_GROUPS.has(group)
    : namespace === 'ai' && AI_GROUPS.has(group)
  if (!supported || req.headers.has('cookie')) {
    return jsonResponse({ error: 'This endpoint requires a personal session' }, { status: 403 })
  }
  const grant = await resolveServiceActor(db, token)
  if (!grant) return jsonResponse({ error: 'Service connection expired, revoked or unavailable' }, { status: 401 })
  const actor = grant.user
  if (req.headers.has('X-Instatic-Branch') && !['GET', 'HEAD'].includes(req.method) &&
      (namespace === 'ai' || ['media', 'mail', 'plugins'].includes(group))) {
    return jsonResponse({ error: 'This write is installation-wide. Omit the branch to target the installation explicitly.' }, { status: 400 })
  }
  if (pathname === '/admin/api/cms/cli-context' && req.method === 'GET') {
    const available = operations.filter(op => op.any.some(c => actor.capabilities.includes(c)))
    const describe = new URL(req.url).searchParams.get('describe')
    if (describe) {
      const operation = available.find(op => op.method + ' ' + op.path === describe)
      return operation ? jsonResponse(operation) : jsonResponse({ error: 'Unknown or unavailable operation' }, { status: 404 })
    }
    return jsonResponse({
      account: actor.id, name: actor.displayName, scope: 'installation', expiresAt: grant.expiresAt, capabilities: actor.capabilities,
      operations: available.map(({ method, path, summary, example }) => ({ method, path, summary, example })),
    })
  }
  return bindServicePrincipal(req, actor)
}
