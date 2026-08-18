/**
 * SSRF-guarded download of an image from the public internet.
 *
 * Extracted from the MCP `upload_media` tool so the Unsplash importer rides
 * the same guards rather than growing a second, subtly weaker copy. Every
 * caller here is "the server fetches a URL that some client chose", which is
 * the exact shape that turns a CMS into an internal-network scanner if the
 * checks are not identical everywhere.
 *
 * What it guarantees:
 *   - https only,
 *   - the host resolves, and NO resolved address is in a blocked range
 *     (loopback, private, link-local — see `isBlockedAddress`),
 *   - redirects are followed MANUALLY and re-validated at every hop, so an
 *     allowed-looking host cannot bounce the download to an internal target,
 *   - the response body is read under a hard byte ceiling and a wall clock.
 *
 * Residual note, inherited and unchanged: addresses are validated and then
 * `fetch` re-resolves by hostname — the same DNS-rebinding window the rest of
 * the host tolerates.
 */
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { isBlockedAddress } from '../../plugins/host/network'

const MAX_IMAGE_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const FETCH_TIMEOUT_MS = 15_000

/** Strip an IPv6 URL bracket wrapper so `isIP`/`isBlockedAddress` see the raw address. */
function unbracketHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Validate one outbound target. Re-run for every redirect hop — validating
 * only the first URL is the classic way this check gets defeated.
 */
export async function assertPublicHttpsTarget(
  urlString: string,
  signal: AbortSignal,
): Promise<URL> {
  signal.throwIfAborted()
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error(`Invalid image URL: "${urlString}"`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Image URL must be an https URL (got "${parsed.protocol}").`)
  }
  const host = unbracketHost(parsed.hostname)
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((r) => r.address)
  signal.throwIfAborted()
  if (addresses.length === 0) {
    throw new Error(`Image URL host "${host}" did not resolve to any address.`)
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(
        `Image URL host "${host}" resolves to a blocked address (${address}).`,
      )
    }
  }
  return parsed
}

/** Read a response stream into a buffer, aborting if it exceeds `maxBytes`. */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    signal.throwIfAborted()
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`Image exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Download an image the caller named by URL, under every guard above.
 * `maxBytes` is the caller's policy — the media library and the MCP tool
 * happen to share one today, but the ceiling belongs to the surface.
 */
export async function downloadRemoteImage(
  sourceUrl: string,
  maxBytes: number,
  requestSignal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const signal = AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(FETCH_TIMEOUT_MS),
  ])
  let current = sourceUrl
  for (let hop = 0; ; hop++) {
    const target = await assertPublicHttpsTarget(current, signal)
    const response = await fetch(target, {
      redirect: 'manual',
      signal,
    })
    const location = response.headers.get('location')
    if (REDIRECT_STATUSES.has(response.status) && location) {
      if (hop >= MAX_IMAGE_REDIRECTS) {
        throw new Error(`Image URL exceeded ${MAX_IMAGE_REDIRECTS} redirects.`)
      }
      await response.body?.cancel()
      current = new URL(location, current).toString()
      continue
    }
    if (!response.ok || !response.body) {
      throw new Error(`Image download failed (HTTP ${response.status}).`)
    }
    return readBounded(response.body, maxBytes, signal)
  }
}
