import type { AuthUser } from '../repositories/users'

// The CMS and AI dispatchers bind the result of credential verification.
// Downstream handlers (including plugin runtime routes) get an actor, never
// the opaque credential that proved its identity.
const actors = new WeakMap<Request, AuthUser>()

export function bindServicePrincipal(req: Request, actor: AuthUser): Request {
  const headers = new Headers(req.headers)
  headers.delete('authorization')
  const authenticated = new Request(req, { headers })
  actors.set(authenticated, actor)
  return authenticated
}

export function servicePrincipal(req: Request): AuthUser | undefined {
  return actors.get(req)
}
