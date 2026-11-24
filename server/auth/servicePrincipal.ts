import type { AuthUser } from '../repositories/users'

// The CMS and AI dispatchers bind the result of credential verification.
// Downstream handlers (including plugin runtime routes) get an actor, never
// the opaque credential that proved its identity.
interface ServicePrincipal {
  user: AuthUser
}
const actors = new WeakMap<Request, ServicePrincipal>()

export function bindServicePrincipal(req: Request, actor: ServicePrincipal): Request {
  const headers = new Headers(req.headers)
  headers.delete('authorization')
  const authenticated = new Request(req, { headers })
  actors.set(authenticated, actor)
  return authenticated
}

export function servicePrincipal(req: Request): ServicePrincipal | undefined {
  return actors.get(req)
}
