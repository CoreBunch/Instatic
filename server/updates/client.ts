import { compare, prerelease, valid } from 'semver'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { INSTATIC_RELEASES_URL, UPDATE_CACHE_MS, type UpdateDetails, type UpdateStatus } from '@core/updates'
import { buildInfo } from './buildInfo'

const RELEASE_API = 'https://api.github.com/repos/CoreBunch/Instatic/releases/latest'
const MIN_REFRESH_MS = 60 * 1000
const RETRY_MS = 5 * 60 * 1000
const MAX_RESPONSE_BYTES = 512 * 1024
const GitHubReleaseSchema = Type.Object({
  tag_name: Type.String(),
  html_url: Type.String(),
  published_at: Type.String(),
  draft: Type.Literal(false),
  prerelease: Type.Literal(false),
  body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

let release: UpdateStatus['latest'] = null
let releaseNotes: string | null = null
let checkedAt: number | null = null
let attemptedAt: number | null = null
let retryAt = 0
let etag: string | null = null
let error: string | null = null
let pending: Promise<void> | null = null

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty GitHub response')
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('GitHub response too large')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => { /* The stream may already be aborted. */ })
    reader.releaseLock()
  }
}

function retryAfter(response: Response, now: number): number {
  const raw = response.headers.get('retry-after')
  const seconds = raw === null ? NaN : Number(raw)
  const after = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(raw ?? '')
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
  return Math.max(now + RETRY_MS, Number.isFinite(after) ? after : 0, Number.isFinite(reset) ? reset : 0)
}

async function checkRelease(): Promise<void> {
  const now = Date.now()
  attemptedAt = now
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Instatic-Updates',
    }
    if (etag) headers['If-None-Match'] = etag
    // Fixed official upstream only. No installation URL, credentials or
    // customer data is sent to GitHub. Redirects cannot change the host.
    const response = await fetch(RELEASE_API, {
      headers, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000),
    })
    if (!response.ok && response.status !== 304) {
      retryAt = retryAfter(response, now)
      await response.body?.cancel()
      throw new Error('GitHub release check failed')
    }
    if (response.status !== 304) {
      const parsed = safeParseValue(GitHubReleaseSchema, JSON.parse(await readBoundedBody(response)))
      if (!parsed.ok) throw new Error('Invalid release response')
      const data = parsed.value
      const version = valid(data.tag_name)
      if (!version || prerelease(version) || data.html_url !== `${INSTATIC_RELEASES_URL}/tag/${data.tag_name}` || !Number.isFinite(Date.parse(data.published_at))) {
        throw new Error('Invalid stable release metadata')
      }
      release = { version, url: data.html_url, publishedAt: data.published_at }
      releaseNotes = data.body?.slice(0, 12000) ?? ''
      etag = response.headers.get('etag')
    } else if (!release) {
      throw new Error('No cached release for conditional response')
    }
    checkedAt = Date.now()
    error = null
    retryAt = 0
  } catch (_err) {
    // Retain historical evidence and never expose raw upstream bodies or
    // network exception details. An outage is not an up-to-date result.
    error = 'GitHub release status is unavailable. The last successful result may be out of date.'
    retryAt = Math.max(retryAt, Date.now() + RETRY_MS)
  }
}

async function ensureRelease(refresh: boolean): Promise<void> {
  if (pending) return pending
  const now = Date.now()
  if (now < retryAt || (!error && attemptedAt !== null && now - attemptedAt < (refresh ? MIN_REFRESH_MS : UPDATE_CACHE_MS))) return
  pending = checkRelease().finally(() => { pending = null })
  return pending
}

function snapshot(): UpdateStatus {
  const difference = release && buildInfo.version ? compare(release.version, buildInfo.version) : null
  return {
    build: buildInfo,
    latest: release,
    comparison: difference === null ? 'unknown' : difference > 0 ? 'update-available' : difference < 0 ? 'ahead' : 'current',
    checkedAt,
    stale: checkedAt === null || Date.now() - checkedAt >= UPDATE_CACHE_MS || error !== null,
    error,
    nextCheckAt: error ? retryAt : (attemptedAt ?? Date.now()) + UPDATE_CACHE_MS,
  }
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  await ensureRelease(false)
  return snapshot()
}

export async function getUpdateDetails(refresh = false): Promise<UpdateDetails> {
  await ensureRelease(refresh)
  return { ...snapshot(), releaseNotes }
}
