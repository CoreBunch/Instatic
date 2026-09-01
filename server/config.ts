interface ServerConfig {
  port: number
  databaseUrl: string
  uploadsDir: string
  staticDir: string
  trustedProxyCidrs: string[]
  publicOrigins: string[]
  publicApiProxyUrl: string | null
}

function readCsvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * Normalize a raw origin string to a canonical `scheme://host[:port]` form.
 *
 * Parsing goes through the `URL` constructor (no regex, no `as`): the scheme
 * and host are lowercased, an explicit non-default port is preserved, and any
 * path / query / fragment / trailing slash is stripped. Returns `null` for
 * anything the `URL` constructor rejects or that has no usable host.
 *
 * Exported so `server/auth/security.ts` normalizes inbound Origin headers the
 * exact same way it normalized the configured origins — the CSRF comparison is
 * a string equality of two normalized values, so the two paths must agree.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (!url.hostname) return null
    const scheme = url.protocol.replace(':', '').toLowerCase()
    const host = url.hostname.toLowerCase()
    const port = url.port ? `:${url.port}` : ''
    return `${scheme}://${host}${port}`
  } catch {
    return null
  }
}

function normalizeOrigins(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const normalized = normalizeOrigin(entry)
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      out.push(normalized)
    }
  }
  return out
}

function normalizeHttpBaseUrl(raw: string | undefined): string | null {
  if (!raw?.trim()) return null
  try {
    const url = new URL(raw.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null
    if (url.username || url.password) return null
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/**
 * The set of public origins the CSRF check derives `expectedOrigin` from.
 *
 * Precedence:
 *   1. `PUBLIC_ORIGIN` — comma-separated list (platform domain + custom domain
 *      can coexist). Invalid entries are dropped; a list that survives
 *      normalization with at least one entry wins outright.
 *   2. Platform auto-detection — `RENDER_EXTERNAL_URL` (full URL) and/or
 *      `https://${RAILWAY_PUBLIC_DOMAIN}` (host only). Both are included when
 *      both env vars are present, keeping one-click deploys config-free.
 *      Reached when `PUBLIC_ORIGIN` is unset *or* every entry in it is
 *      unparseable, so a malformed value degrades to auto-detection rather
 *      than suppressing it.
 *   3. `[]` — no public origin configured; the CSRF check falls back to the
 *      inbound `Host` header.
 */
export function resolvePublicOrigins(env: Record<string, string | undefined>): string[] {
  // Normalize before the precedence test, not after: gating on the raw CSV
  // length lets an all-invalid PUBLIC_ORIGIN return [] while still claiming
  // precedence, which suppresses platform auto-detection entirely.
  const explicit = normalizeOrigins(readCsvList(env.PUBLIC_ORIGIN))
  if (explicit.length > 0) {
    return explicit
  }

  const derived: string[] = []
  if (env.RENDER_EXTERNAL_URL) derived.push(env.RENDER_EXTERNAL_URL)
  if (env.RAILWAY_PUBLIC_DOMAIN) derived.push(`https://${env.RAILWAY_PUBLIC_DOMAIN}`)
  return normalizeOrigins(derived)
}

export function readServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  return {
    port: Number(env.PORT ?? 3001),
    databaseUrl: env.DATABASE_URL ?? 'sqlite:./.tmp/dev.db',
    uploadsDir: env.UPLOADS_DIR ?? './uploads',
    staticDir: env.STATIC_DIR ?? './dist',
    trustedProxyCidrs: readCsvList(env.TRUSTED_PROXY_CIDRS),
    publicOrigins: resolvePublicOrigins(env),
    publicApiProxyUrl: normalizeHttpBaseUrl(env.PUBLIC_API_PROXY_URL),
  }
}
