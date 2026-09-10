import { describe, expect, it } from 'bun:test'
import { getCmsPublishStatus, publishCmsDraft } from '@core/persistence'

describe('publishCmsDraft', () => {
  it('posts to the CMS publish endpoint with session credentials', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    const result = await publishCmsDraft(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ publishedPages: 2 }), { status: 200 })
    })

    expect(result).toEqual({ publishedPages: 2 })
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/publish',
      init: { method: 'POST', credentials: 'include' },
    })
  })

  it('throws when the publish API rejects the request', async () => {
    await expect(
      publishCmsDraft(async () =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })),
    ).rejects.toThrow('Unauthorized')
  })

  it('loads persisted CMS publish status with session credentials', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    const result = await getCmsPublishStatus(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        hasPublishedVersion: true,
        draftMatchesPublished: true,
        draftPages: 1,
        publishedPages: 1,
        lastPublishedAt: '2026-01-03T00:00:00.000Z',
      }), { status: 200 })
    })

    expect(result.draftMatchesPublished).toBe(true)
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/publish/status',
      init: { method: 'GET', credentials: 'include' },
    })
  })
})
