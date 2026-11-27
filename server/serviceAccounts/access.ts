import { membershipGuide } from './membershipGuide'
import type { DbClient } from '../db/client'
import { jsonResponse } from '../http'
import { resolveServiceActor } from './store'
import { bindServicePrincipal } from '../auth/servicePrincipal'
import { availableOperations, describeOperation } from './catalog'

// Browser identity, consent and workspace callbacks are not CMS operations.
const browserOnlyCms = new Set(['setup', 'login', 'logout', 'auth', 'me', 'service-accounts'])
const browserOnlyAi = new Set(['mcp', 'editor-bridge', 'tool-result'])
const installationWrites = new Set(['users', 'roles', 'members', 'fonts', 'media', 'mail', 'plugins'])

export function tryAuthorizeServiceRequest(req: Request, db: DbClient): Promise<Request | Response> | null {
  const match = /^Bearer\s+(icli_\S+)$/i.exec(req.headers.get('authorization') ?? '')
  return match ? authorize(req, db, match[1]) : null
}

async function authorize(req: Request, db: DbClient, token: string): Promise<Request | Response> {
  const pathname = new URL(req.url).pathname
  const [, , , namespace, group] = pathname.split('/')
  const browserOnly = namespace === 'cms' ? browserOnlyCms.has(group) : browserOnlyAi.has(group)
  if (browserOnly || req.headers.has('cookie')) {
    return jsonResponse({ error: 'This endpoint requires a personal session' }, { status: 403 })
  }
  const grant = await resolveServiceActor(db, token)
  if (!grant) return jsonResponse({ error: 'Service connection expired, revoked or unavailable' }, { status: 401 })
  const actor = grant.user
  if (req.headers.has('X-Instatic-Branch') && !['GET', 'HEAD'].includes(req.method) &&
      (namespace === 'ai' ? group !== 'chat' : installationWrites.has(group))) {
    return jsonResponse({ error: 'This write is installation-wide. Omit the branch to target the installation explicitly.' }, { status: 400 })
  }
  if (pathname === '/admin/api/cms/cli-context' && req.method === 'GET') {
    const available = availableOperations(actor.capabilities)
    const describe = new URL(req.url).searchParams.get('describe')
    if (describe) {
      const operation = available.find(op => op.method + ' ' + op.path === describe)
      return operation ? jsonResponse(describeOperation(operation)) : jsonResponse({ error: 'Unknown or unavailable operation' }, { status: 404 })
    }
    return jsonResponse({
      account: actor.id, name: actor.displayName, scope: 'installation', expiresAt: grant.expiresAt, capabilities: actor.capabilities,
      guide: new URL(req.url).searchParams.get('guide') === 'membership' ? await membershipGuide(req, db, available) : undefined,
      guides: [
        { topic: 'membership', command: 'instatic api lookup "public signup"', summary: 'Build login, signup, verification and protected member pages.' },
        ...(available.some(op => op.path === 'canvas/catalog') ? [{ topic: 'collections', command: 'instatic canvas collection --branch BRANCH', summary: 'Discover visible tables and generate a bound listing for a table.' }] : []),
        ...(available.some(op => op.path === 'canvas/visitor') ? [{ topic: 'visitor', command: 'instatic visit /PATH --branch BRANCH', summary: 'Exercise scripts, search and entry links on your review branch.' }] : []),
      ],
      operations: available.map(({ method, path, summary, permissions }) => ({ method, path, summary, permissions })),
    })
  }
  return bindServicePrincipal(req, grant)
}
