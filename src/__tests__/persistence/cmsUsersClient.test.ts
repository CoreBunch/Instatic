import { describe, expect, it } from 'bun:test'
import {
  listCmsRoles,
  listCmsUsers,
} from '@core/persistence/cmsUsers'

describe('CMS users client', () => {
  it('rejects malformed user list payloads at the HTTP boundary', async () => {
    await expect(
      listCmsUsers({}, async () =>
        new Response(JSON.stringify({
          matching: 1, offset: 0,
          users: [{
            id: 'user_1',
            email: 'owner@example.com',
          }],
        }), { status: 200 })),
    ).rejects.toThrow('/users/0')
  })

  it('rejects malformed role list payloads at the HTTP boundary', async () => {
    await expect(
      listCmsRoles(async () =>
        new Response(JSON.stringify({
          roles: [{
            id: 'role_1',
            slug: 'editor',
          }],
        }), { status: 200 })),
    ).rejects.toThrow('/roles/0')
  })
})
