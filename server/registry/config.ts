/**
 * Registry endpoints the server talks to.
 *
 * `NPM_REGISTRY_URL` points every registry read (search, packuments, the
 * dependency resolver) and the runtime `bun install` at one registry, so a
 * self-hosted install behind a private registry or a corporate mirror needs a
 * single setting. It is parsed once at boot by `readServerConfig()` and handed
 * here through `configureNpmRegistryUrl()`, the same way public origins reach
 * the CSRF check. Downloads and advisories come from npm's public stats API
 * and OSV, which have no private-registry equivalent; they are skipped when
 * the configured registry is not the public one.
 */
import { stripTrailingSlashes } from '@core/utils/urlValidation'
import type { RegistryProfile } from '@core/registry'

export const DEFAULT_NPM_REGISTRY_URL = 'https://registry.npmjs.org'
export const NPM_DOWNLOADS_API_URL = 'https://api.npmjs.org'
export const OSV_API_URL = 'https://api.osv.dev'

let configuredRegistryUrl = DEFAULT_NPM_REGISTRY_URL

/**
 * Absolute `http(s)` origin plus optional path, trailing slash stripped.
 * Anything else falls back to the public registry with one boot-time warning:
 * a typo in an env var must not turn every dependency install into a cryptic
 * 404, and must not spam the log on every request either.
 */
export function parseNpmRegistryUrl(raw: string | undefined): string {
  const trimmed = raw?.trim()
  if (!trimmed) return DEFAULT_NPM_REGISTRY_URL
  try {
    const url = new URL(trimmed)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) {
      throw new Error('unsupported protocol')
    }
    return stripTrailingSlashes(url.toString())
  } catch {
    console.warn(`[registry] Ignoring invalid NPM_REGISTRY_URL "${trimmed}" and using ${DEFAULT_NPM_REGISTRY_URL}`)
    return DEFAULT_NPM_REGISTRY_URL
  }
}

/** Called once from `server/index.ts` with the value `readServerConfig()` parsed. */
export function configureNpmRegistryUrl(url: string): void {
  configuredRegistryUrl = stripTrailingSlashes(url) || DEFAULT_NPM_REGISTRY_URL
}

export function npmRegistryUrl(): string {
  return configuredRegistryUrl
}

/**
 * Only the public registry gets npm's search qualifiers, download statistics,
 * OSV lookups and npmjs.com links. A mirror of it is treated as private: it
 * costs a few decorations, whereas the reverse would leak private package
 * names to public APIs.
 */
export function isPublicNpmRegistry(registryUrl: string): boolean {
  return stripTrailingSlashes(registryUrl) === DEFAULT_NPM_REGISTRY_URL
}

/** What the Dependencies panel is told about the registry; never the URL itself, which may carry credentials. */
export function registryProfile(): RegistryProfile {
  return { host: new URL(configuredRegistryUrl).host, publicNpm: isPublicNpmRegistry(configuredRegistryUrl) }
}
