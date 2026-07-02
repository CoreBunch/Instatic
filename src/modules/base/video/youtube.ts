/**
 * YouTube URL helpers shared by `base.video`'s publisher render path and
 * its editor preview component.
 *
 * Two responsibilities:
 *   - `parseYoutubeId(url)` recognises the standard YouTube URL shapes
 *     (watch / youtu.be / embed / shorts, with optional `?t=` or other
 *     query params). Returns the bare 11-char video ID or `null`.
 *   - `youtubeEmbedUrl(id, autoplay)` builds the privacy-respecting
 *     `youtube.com/embed/<id>` URL with optional autoplay flag.
 *
 * Kept in its own `.ts` (no JSX) module so React Fast Refresh works for
 * the sibling `VideoEditor.tsx` without re-running module registration.
 */

// Strictly 11 base64-url characters — that's the canonical YouTube video
// ID shape. Anything else is rejected so we don't false-positive on
// arbitrary paths.
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

/**
 * Extract the 11-char video ID from any standard YouTube URL. Returns
 * `null` for non-YouTube URLs, malformed inputs, or URLs we don't
 * recognise. Strict by design — we'd rather render a missing video as
 * "no video set" than embed something unexpected.
 *
 * Accepts:
 *   - `https://www.youtube.com/watch?v=ID`
 *   - `https://youtube.com/watch?v=ID&t=42s`
 *   - `https://m.youtube.com/watch?v=ID`
 *   - `https://youtu.be/ID`
 *   - `https://youtu.be/ID?t=42s`
 *   - `https://www.youtube.com/embed/ID`
 *   - `https://www.youtube.com/shorts/ID`
 *   - `https://www.youtube-nocookie.com/embed/ID`
 */
export function parseYoutubeId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')

  if (host === 'youtu.be') {
    const candidate = parsed.pathname.replace(/^\//, '').split('/')[0]
    return VIDEO_ID_RE.test(candidate) ? candidate : null
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (parsed.pathname === '/watch') {
      const v = parsed.searchParams.get('v')
      return v && VIDEO_ID_RE.test(v) ? v : null
    }
    const embedMatch = parsed.pathname.match(/^\/(?:embed|shorts|v)\/([^/?#]+)/)
    if (embedMatch && VIDEO_ID_RE.test(embedMatch[1])) {
      return embedMatch[1]
    }
  }

  return null
}

/**
 * Build the YouTube embed URL for a parsed video ID. Returns an empty
 * string when the ID is unsafe so the caller can no-op cleanly.
 *
 * `encodeURIComponent` is overkill for an 11-char base64-url ID (those
 * chars are URL-safe) but it costs nothing and keeps the contract honest
 * against any future caller that relaxes `parseYoutubeId`'s strictness.
 */
export function youtubeEmbedUrl(
  id: string,
  autoplay: boolean,
  noRelatedVideos: boolean = false,
): string {
  const safeId = encodeURIComponent(id.trim())
  if (!safeId) return ''
  const params: string[] = []
  if (autoplay) params.push('autoplay=1')
  if (noRelatedVideos) params.push('rel=0')
  const qs = params.length > 0 ? `?${params.join('&')}` : ''
  return `https://www.youtube.com/embed/${safeId}${qs}`
}
