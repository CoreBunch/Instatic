/**
 * Unsplash client — projection, attribution, and configuration.
 *
 * The attribution cases are the reason this file exists. Missing UTM
 * parameters or a missing credit line breaks the Unsplash licence while
 * everything still renders perfectly, so nothing in the app would ever tell
 * us. A test is the only thing that notices.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  UnsplashApiError,
  UnsplashNotConfiguredError,
  attributionCaption,
  isUnsplashConfigured,
  listPhotos,
  searchPhotos,
} from '../../../server/handlers/cms/unsplashClient'

const realFetch = globalThis.fetch
const realKey = process.env.UNSPLASH_ACCESS_KEY

/** One photo in Unsplash's own shape, trimmed to the fields we read. */
function wirePhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abc123',
    width: 4000,
    height: 3000,
    color: '#c0ffee',
    blur_hash: 'LKO2:N%2Tw=w',
    description: null,
    alt_description: 'a grey coupe on a gravel road',
    urls: {
      raw: 'https://images.unsplash.com/photo-abc123',
      small: 'https://images.unsplash.com/photo-abc123?w=400',
      thumb: 'https://images.unsplash.com/photo-abc123?w=200',
    },
    links: {
      html: 'https://unsplash.com/photos/abc123',
      download_location: 'https://api.unsplash.com/photos/abc123/download',
    },
    user: { name: 'Ada Lovelace', username: 'ada' },
    ...overrides,
  }
}

function stubFetch(handler: (url: string) => { status?: number; body: unknown }) {
  const calls: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const { status = 200, body } = handler(url)
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof globalThis.fetch
  return calls
}

beforeEach(() => {
  process.env.UNSPLASH_ACCESS_KEY = 'test-key'
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.UNSPLASH_ACCESS_KEY
  else process.env.UNSPLASH_ACCESS_KEY = realKey
})

describe('isUnsplashConfigured', () => {
  it('is false for an unset or blank key', () => {
    delete process.env.UNSPLASH_ACCESS_KEY
    expect(isUnsplashConfigured()).toBe(false)
    process.env.UNSPLASH_ACCESS_KEY = '   '
    expect(isUnsplashConfigured()).toBe(false)
  })

  it('is true once a key is present', () => {
    expect(isUnsplashConfigured()).toBe(true)
  })
})

describe('listPhotos', () => {
  it('projects Unsplash JSON onto the admin shape', async () => {
    stubFetch(() => ({ body: [wirePhoto()] }))
    const page = await listPhotos(1, 30, AbortSignal.timeout(5_000))
    const photo = page.photos[0]!

    expect(photo.id).toBe('abc123')
    expect(photo.description).toBe('a grey coupe on a gravel road')
    expect(photo.thumbUrl).toBe('https://images.unsplash.com/photo-abc123?w=400')
    expect(photo.photographerName).toBe('Ada Lovelace')
    expect(photo.width).toBe(4000)
  })

  // Licence obligation: both attribution links must carry the UTM parameters
  // Unsplash's API terms require. Nothing in the UI fails without them.
  it('UTM-tags both attribution links', async () => {
    stubFetch(() => ({ body: [wirePhoto()] }))
    const page = await listPhotos(1, 30, AbortSignal.timeout(5_000))
    const photo = page.photos[0]!

    for (const url of [photo.photographerUrl, photo.unsplashUrl]) {
      const parsed = new URL(url)
      expect(parsed.searchParams.get('utm_source')).toBe('instatic')
      expect(parsed.searchParams.get('utm_medium')).toBe('referral')
    }
    expect(photo.photographerUrl).toContain('/@ada')
  })

  it('sends the key as a Client-ID credential, never in the URL', async () => {
    const calls = stubFetch(() => ({ body: [] }))
    await listPhotos(1, 30, AbortSignal.timeout(5_000))
    expect(calls[0]).not.toContain('test-key')
  })

  // `hasMore` drives the picker's infinite scroll; the feed endpoint returns
  // no total, so a full page is the only available signal that more exist.
  it('infers hasMore from a full page', async () => {
    stubFetch(() => ({ body: [wirePhoto(), wirePhoto({ id: 'b' })] }))
    expect((await listPhotos(1, 2, AbortSignal.timeout(5_000))).hasMore).toBe(true)
    expect((await listPhotos(1, 3, AbortSignal.timeout(5_000))).hasMore).toBe(false)
  })

  it('survives a photo with no user and no description', async () => {
    stubFetch(() => ({
      body: [wirePhoto({ user: undefined, description: null, alt_description: null })],
    }))
    const photo = (await listPhotos(1, 30, AbortSignal.timeout(5_000))).photos[0]!
    expect(photo.description).toBe('')
    expect(photo.photographerName).toBe('Unknown')
    // Still a valid, UTM-tagged link — an anonymous credit is better than a
    // broken href.
    expect(new URL(photo.photographerUrl).searchParams.get('utm_source')).toBe('instatic')
  })
})

describe('searchPhotos', () => {
  it('pages on total_pages rather than page fullness', async () => {
    stubFetch(() => ({ body: { total: 40, total_pages: 2, results: [wirePhoto()] } }))
    expect((await searchPhotos('cars', 1, 30, AbortSignal.timeout(5_000))).hasMore).toBe(true)
    expect((await searchPhotos('cars', 2, 30, AbortSignal.timeout(5_000))).hasMore).toBe(false)
  })

  it('encodes the query instead of splicing it into the path', async () => {
    const calls = stubFetch(() => ({ body: { total_pages: 1, results: [] } }))
    await searchPhotos('a&b c', 1, 30, AbortSignal.timeout(5_000))
    expect(calls[0]).toContain('query=a%26b%20c')
  })
})

describe('failure modes', () => {
  it('names the misconfiguration when no key is set', async () => {
    delete process.env.UNSPLASH_ACCESS_KEY
    stubFetch(() => ({ body: [] }))
    await expect(listPhotos(1, 30, AbortSignal.timeout(5_000)))
      .rejects.toBeInstanceOf(UnsplashNotConfiguredError)
  })

  it('distinguishes a rejected key from a rate limit', async () => {
    stubFetch(() => ({ status: 401, body: {} }))
    await expect(listPhotos(1, 30, AbortSignal.timeout(5_000)))
      .rejects.toThrow(/access key/i)

    stubFetch(() => ({ status: 403, body: {} }))
    await expect(listPhotos(1, 30, AbortSignal.timeout(5_000)))
      .rejects.toThrow(/rate limit/i)
  })

  it('carries the upstream status on the error', async () => {
    stubFetch(() => ({ status: 500, body: {} }))
    const err = await listPhotos(1, 30, AbortSignal.timeout(5_000)).catch((e) => e)
    expect(err).toBeInstanceOf(UnsplashApiError)
    expect((err as UnsplashApiError).status).toBe(500)
  })
})

describe('attributionCaption', () => {
  it('credits the photographer and both required links', () => {
    const caption = attributionCaption({
      id: 'x',
      description: '',
      thumbUrl: '',
      width: 0,
      height: 0,
      color: null,
      blurHash: null,
      photographerName: 'Ada Lovelace',
      photographerUrl: 'https://unsplash.com/@ada?utm_source=instatic',
      unsplashUrl: 'https://unsplash.com/photos/x?utm_source=instatic',
    })
    expect(caption).toContain('Ada Lovelace')
    expect(caption).toContain('https://unsplash.com/@ada')
    expect(caption).toContain('https://unsplash.com/photos/x')
    expect(caption).toContain('Unsplash')
  })
})
