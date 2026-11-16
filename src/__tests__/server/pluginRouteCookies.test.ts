import { describe, expect, it } from 'bun:test'
import { serializeRouteRequest } from '../../../server/plugins/host/routeIo'
import { withoutSessionCookies } from '../../../server/sessionCookies'

describe('plugin routes never receive session cookies', () => {
  it('removes the admin and member session cookies and keeps the rest', () => {
    expect(
      withoutSessionCookies(
        'theme=dark; instatic_admin_session=ADMIN; __Host-instatic_member=M1; instatic_member=M2; instatic_member_signup=N; instatic_branch_preview=P; cart=42',
      ),
    ).toBe('theme=dark; cart=42')
    expect(withoutSessionCookies('instatic_admin_session=ADMIN')).toBe('')
  })

  it('applies that to the request a plugin handler is given', async () => {
    const req = new Request('http://localhost/admin/api/cms/plugins/acme/runtime/hello')
    req.headers.set('cookie', 'instatic_admin_session=ADMIN; lang=en')
    const { request } = await serializeRouteRequest(req)
    expect(request.headers.cookie).toBe('lang=en')

    const only = new Request('http://localhost/admin/api/cms/plugins/acme/runtime/hello')
    only.headers.set('cookie', '__Host-instatic_member=M1')
    expect((await serializeRouteRequest(only)).request.headers.cookie).toBeUndefined()
  })
})
