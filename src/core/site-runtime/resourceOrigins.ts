import { isRecord } from '@core/utils/isRecord'
import type { SiteScriptResourceOrigins } from './schemas'

/** Origins only: never CSP keywords, wildcards, credentials or URL paths. */
export function parseResourceOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(trimmed) || /[\s;'"*\\]/.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return /[\s;'"*\\]/.test(url.origin) ? null : url.origin
  } catch (_error) {
    // Invalid user-entered URLs grant no origin.
    return null
  }
}

export function normalizeResourceOrigins(raw: unknown): SiteScriptResourceOrigins | undefined {
  if (!isRecord(raw)) return undefined
  function origins(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return [...new Set(value.flatMap((item) => {
      const origin = typeof item === 'string' ? parseResourceOrigin(item) : null
      return origin ? [origin] : []
    }))].sort()
  }
  const styles = origins(raw.styles)
  const fonts = origins(raw.fonts)
  const result = {
    scripts: origins(raw.scripts), frames: origins(raw.frames), connections: origins(raw.connections),
    ...(styles.length ? { styles } : {}),
    ...(fonts.length ? { fonts } : {}),
  }
  return result.scripts.length || result.frames.length || result.connections.length || styles.length || fonts.length ? result : undefined
}
