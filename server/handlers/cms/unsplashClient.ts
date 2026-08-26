/**
 * Unsplash API client — the only module that knows the access key exists.
 *
 * Talks to `api.unsplash.com` and projects its responses onto a small shape
 * the admin actually needs. Their JSON is an untrusted boundary like any
 * other, so it goes through TypeBox before anything reads a field off it.
 *
 * Configuration is one environment variable, `UNSPLASH_ACCESS_KEY`. There is
 * no settings row and no encryption, because there is no secret to protect
 * per-user: the key is one installation-wide credential, and a self-hosted CMS
 * already has it in the same place as `DATABASE_URL`. `isUnsplashConfigured()`
 * is what the admin uses to decide whether to show the feature at all — an
 * install without a key never sees a button that can only fail.
 *
 * The key never reaches the browser. Every call the admin makes is proxied
 * through `mediaUnsplash.ts`, which is also why the import endpoint takes a
 * photo ID rather than a URL: the server re-fetches the photo and reads the
 * download URL from Unsplash's own response, so no client-supplied URL is ever
 * downloaded.
 *
 * ## Licence obligations
 *
 * Two of these are API terms, not preferences:
 *
 *   1. **Attribution.** Every displayed photo names the photographer and links
 *      to their profile and to Unsplash, both carrying the required UTM
 *      parameters. `attributionLinks()` builds them in one place.
 *   2. **Download tracking.** When a photo is actually used — imported here,
 *      not merely browsed — the app must hit the photo's `download_location`.
 *      `triggerDownload()` does that, and `importable()` calls it. Skipping it
 *      breaks the terms even though nothing visibly fails.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonResponse } from '@core/utils/jsonValidate'

const API_ORIGIN = 'https://api.unsplash.com'
const API_VERSION = 'v1'
const REQUEST_TIMEOUT_MS = 15_000

/**
 * UTM source Unsplash attributes traffic to. Their guidelines ask for the
 * integrating application's name; this CMS is that application regardless of
 * which site it happens to be serving.
 */
const UTM_SOURCE = 'instatic'

/**
 * Long edge requested from Unsplash's dynamic resizer on import. Their
 * `raw` URL is the untouched original, which for many photos is 6000px+ and
 * tens of megabytes — more than any web page needs and enough to make the
 * variant ladder slow to build. 2400px keeps a 2× retina full-bleed hero
 * sharp, which is the widest thing this CMS renders.
 */
const IMPORT_WIDTH = 2400
const IMPORT_QUALITY = 80

// ---------------------------------------------------------------------------
// Their wire shape — only the fields we read, all optional-tolerant
// ---------------------------------------------------------------------------

const UnsplashUserSchema = Type.Object({
  name: Type.Optional(Type.String()),
  username: Type.Optional(Type.String()),
})

const UnsplashPhotoSchema = Type.Object({
  id: Type.String(),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  blur_hash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  alt_description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  urls: Type.Object({
    raw: Type.String(),
    small: Type.Optional(Type.String()),
    thumb: Type.Optional(Type.String()),
  }),
  links: Type.Object({
    html: Type.Optional(Type.String()),
    download_location: Type.Optional(Type.String()),
  }),
  user: Type.Optional(UnsplashUserSchema),
})

const UnsplashPhotoListSchema = Type.Array(UnsplashPhotoSchema)

const UnsplashSearchSchema = Type.Object({
  total: Type.Optional(Type.Number()),
  total_pages: Type.Optional(Type.Number()),
  results: UnsplashPhotoListSchema,
})

const UnsplashDownloadSchema = Type.Object({
  url: Type.String(),
})

type UnsplashPhotoWire = Static<typeof UnsplashPhotoSchema>

// ---------------------------------------------------------------------------
// Our shape — what the admin receives
// ---------------------------------------------------------------------------

export interface UnsplashPhoto {
  id: string
  /** Best available human description; '' when Unsplash has none. */
  description: string
  /** Small URL for the picker grid. */
  thumbUrl: string
  width: number
  height: number
  /** Average colour, used as the tile background while the thumb loads. */
  color: string | null
  blurHash: string | null
  photographerName: string
  /** Attribution link to the photographer's profile, UTM-tagged. */
  photographerUrl: string
  /** Attribution link to the photo on Unsplash, UTM-tagged. */
  unsplashUrl: string
}

export interface UnsplashPage {
  photos: UnsplashPhoto[]
  /** True when another page exists — drives the picker's infinite scroll. */
  hasMore: boolean
}

export class UnsplashNotConfiguredError extends Error {
  constructor() {
    super('Unsplash is not configured on this installation.')
    this.name = 'UnsplashNotConfiguredError'
  }
}

export class UnsplashApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'UnsplashApiError'
    this.status = status
  }
}

/** Read at call time, not module load, so tests and reloads see edits. */
function accessKey(): string {
  return (process.env.UNSPLASH_ACCESS_KEY ?? '').trim()
}

export function isUnsplashConfigured(): boolean {
  return accessKey().length > 0
}

/** Append the UTM parameters Unsplash's attribution guidelines require. */
function withUtm(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('utm_source', UTM_SOURCE)
    parsed.searchParams.set('utm_medium', 'referral')
    return parsed.toString()
  } catch {
    return url
  }
}

async function unsplashFetch(path: string, signal: AbortSignal): Promise<Response> {
  const key = accessKey()
  if (!key) throw new UnsplashNotConfiguredError()

  const res = await fetch(`${API_ORIGIN}${path}`, {
    headers: {
      authorization: `Client-ID ${key}`,
      'accept-version': API_VERSION,
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  })

  if (!res.ok) {
    // 401 means the configured key is wrong — worth saying plainly, because
    // the alternative is an admin staring at an empty grid. 403 from Unsplash
    // is almost always the hourly rate limit rather than a permission problem.
    const detail = res.status === 401
      ? 'Unsplash rejected the configured access key.'
      : res.status === 403
        ? 'Unsplash rate limit reached. Try again shortly.'
        : `Unsplash request failed (HTTP ${res.status}).`
    throw new UnsplashApiError(res.status, detail)
  }
  return res
}

function toPhoto(wire: UnsplashPhotoWire): UnsplashPhoto {
  const username = wire.user?.username ?? ''
  return {
    id: wire.id,
    description: wire.alt_description || wire.description || '',
    // `small` and `thumb` are optional in their schema but present in
    // practice; `raw` is the guaranteed one, so it is the honest fallback.
    thumbUrl: wire.urls.small ?? wire.urls.thumb ?? wire.urls.raw,
    width: wire.width ?? 0,
    height: wire.height ?? 0,
    color: wire.color ?? null,
    blurHash: wire.blur_hash ?? null,
    photographerName: wire.user?.name ?? 'Unknown',
    photographerUrl: username ? withUtm(`https://unsplash.com/@${username}`) : withUtm('https://unsplash.com'),
    unsplashUrl: withUtm(wire.links.html ?? `https://unsplash.com/photos/${wire.id}`),
  }
}

/**
 * The editorial feed — what the picker shows before anyone types. Unsplash
 * returns no total for this endpoint, so `hasMore` is inferred from whether
 * the page came back full.
 */
export async function listPhotos(
  page: number,
  perPage: number,
  signal: AbortSignal,
): Promise<UnsplashPage> {
  const res = await unsplashFetch(`/photos?page=${page}&per_page=${perPage}`, signal)
  const wire = await parseJsonResponse(res, UnsplashPhotoListSchema)
  return { photos: wire.map(toPhoto), hasMore: wire.length === perPage }
}

export async function searchPhotos(
  query: string,
  page: number,
  perPage: number,
  signal: AbortSignal,
): Promise<UnsplashPage> {
  const res = await unsplashFetch(
    `/search/photos?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`,
    signal,
  )
  const wire = await parseJsonResponse(res, UnsplashSearchSchema)
  const totalPages = wire.total_pages ?? 0
  return { photos: wire.results.map(toPhoto), hasMore: page < totalPages }
}

/**
 * Everything needed to actually pull a photo in: the bytes URL, the credit
 * line, and the side effect of reporting the download to Unsplash.
 *
 * The photo is re-fetched here rather than trusted from the client, so the
 * URL we hand to the downloader always comes from Unsplash itself.
 */
export async function importable(
  photoId: string,
  signal: AbortSignal,
): Promise<{ photo: UnsplashPhoto; downloadUrl: string }> {
  const res = await unsplashFetch(`/photos/${encodeURIComponent(photoId)}`, signal)
  const wire = await parseJsonResponse(res, UnsplashPhotoSchema)

  // Licence obligation, not an optimisation: report the use before serving it.
  // A failure here must not lose the user their import, so it is logged and
  // swallowed — but it is attempted on every single import.
  if (wire.links.download_location) {
    await triggerDownload(wire.links.download_location, signal)
  }

  const url = new URL(wire.urls.raw)
  url.searchParams.set('w', String(IMPORT_WIDTH))
  url.searchParams.set('q', String(IMPORT_QUALITY))
  url.searchParams.set('fm', 'jpg')
  return { photo: toPhoto(wire), downloadUrl: url.toString() }
}

async function triggerDownload(downloadLocation: string, signal: AbortSignal): Promise<void> {
  try {
    // The endpoint is on api.unsplash.com and needs the same auth header, so
    // it goes through `unsplashFetch` with the path Unsplash handed us.
    const parsed = new URL(downloadLocation)
    if (parsed.origin !== API_ORIGIN) return
    const res = await unsplashFetch(`${parsed.pathname}${parsed.search}`, signal)
    await parseJsonResponse(res, UnsplashDownloadSchema)
  } catch (err) {
    console.error('[unsplash] download tracking failed:', err)
  }
}

/**
 * The credit line stored on the imported asset. Plain text plus both required
 * links — this is what keeps the attribution with the photo after the picker
 * is long closed.
 */
export function attributionCaption(photo: UnsplashPhoto): string {
  return `Photo by ${photo.photographerName} (${photo.photographerUrl}) on Unsplash (${photo.unsplashUrl})`
}
