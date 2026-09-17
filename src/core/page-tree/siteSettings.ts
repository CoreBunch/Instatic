/**
 * SiteSettings — per-site configuration stored in SiteDocument.settings.
 * Mirrors `validateSettings` in `validate.ts` (lines ~614–633).
 *
 * Color tokens — REMOVED.
 *
 * The legacy `site.settings.colorTokens` field was the original raw
 * design-token shape (`{ '--color-primary': '#6366f1', ... }`) emitted into a
 * `:root {}` block in the published `framework.css`. It has been fully
 * superseded by the structured framework Color settings
 * (`site.settings.framework.colors`), which is what the editor's Colors panel
 * reads from and writes to.
 *
 * Keeping both paths around silently injected ghost tokens into every fresh
 * project (the old `DEFAULT_COLOR_TOKENS` had seven `#6366f1`-family defaults)
 * that the user could not see or remove via the UI. Per CLAUDE.md ("we are
 * pre-release, don't leave both an old and new implementation side-by-side")
 * the legacy field has been removed entirely; persisted snapshots that still
 * carry a `colorTokens` key are silently dropped on parse.
 *
 * For tolerant parsing (with fallbacks for invalid sub-fields), use
 * `parseSiteSettings` instead of `parseValue(SiteSettingsSchema, raw)`.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { FrameworkSettingsSchema } from '@core/framework-schema'
import { SiteFontsSettingsSchema, parseSiteFontsSettings } from '@core/fonts'

// ---------------------------------------------------------------------------
// SiteCspSettings — site-level Content-Security-Policy allowlist
//
// The publisher's base policy locks `script-src` to `'self'`, which is right
// for a static site but blocks every third-party tag a marketing site needs
// (Google Analytics / Tag Manager loaders, the Meta pixel, chat widgets, …).
// Plugins cannot lift this — `frontend.assets[]` is same-origin only and
// `networkAllowedHosts` reaches `connect-src`, not `script-src`. This is the
// one explicit, owner-controlled place to allow an external origin. Entries
// are exact HTTPS origins (`https://host[:port]`, optionally `https://*.host`)
// — never a scheme wildcard, never `'unsafe-inline'`, never a path — so the
// policy stays a real allowlist.
// ---------------------------------------------------------------------------

/**
 * One CSP host source: `https://` + host (optionally a `*.` wildcard label)
 * + optional port. No path, query, credentials, or trailing slash — CSP
 * ignores everything after the host anyway, so accepting it would only hide
 * typos.
 */
export const CSP_ORIGIN_PATTERN =
  '^https://(?:\\*\\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?::[0-9]{1,5})?$'

const CSP_ORIGIN_RE = new RegExp(CSP_ORIGIN_PATTERN)

/** True when `value` is a CSP host source the allowlist accepts. */
export function isCspOrigin(value: string): boolean {
  return CSP_ORIGIN_RE.test(value)
}

const CspOriginSchema = Type.String({ pattern: CSP_ORIGIN_PATTERN })

export const SiteCspSettingsSchema = Type.Object({
  /** Origins merged into the published page's `script-src` (third-party loaders). */
  scriptOrigins: Type.Array(CspOriginSchema),
  /** Origins merged into `connect-src` (where those scripts send beacons / fetch). */
  connectOrigins: Type.Array(CspOriginSchema),
})

export type SiteCspSettings = Static<typeof SiteCspSettingsSchema>

/**
 * Normalize a raw origin list: trim, drop blanks and anything that is not a
 * valid CSP host source, de-duplicate, keep first-seen order. Used by the
 * tolerant settings parser and by the Settings UI when it commits a textarea.
 */
export function parseCspOriginList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed || !isCspOrigin(trimmed) || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

// ---------------------------------------------------------------------------
// SiteSettingsSchema
// ---------------------------------------------------------------------------

export const SiteSettingsSchema = Type.Object({
  metaTitle: Type.Optional(Type.String()),
  metaDescription: Type.Optional(Type.String()),
  faviconUrl: Type.Optional(Type.String()),
  language: Type.Optional(Type.String()),
  /** Structured framework token settings — absent means framework disabled. */
  framework: Type.Optional(FrameworkSettingsSchema),
  /** Library of installed fonts — absent when no fonts added. */
  fonts: Type.Optional(SiteFontsSettingsSchema),
  /** Third-party origins allowed by the published-page CSP — absent when none. */
  csp: Type.Optional(SiteCspSettingsSchema),
  /** Keyboard shortcut overrides — defaults to {} — handled in parseSiteSettings. */
  shortcuts: Type.Record(Type.String(), Type.String()),
})

export type SiteSettings = Static<typeof SiteSettingsSchema>

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  shortcuts: {},
}

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

/**
 * Parse SiteSettings, providing fallbacks for all resilient fields.
 *
 * Persisted snapshots from older versions may carry a top-level `colorTokens`
 * field — that legacy data path was removed in favour of the structured
 * framework Color settings (`framework.colors`). Any persisted `colorTokens`
 * key is silently dropped here (no migration: per CLAUDE.md, the dev DB is
 * disposable and there are no production users).
 */
export function parseSiteSettings(raw: unknown): SiteSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_SITE_SETTINGS
  const r = raw as Record<string, unknown>

  const shortcuts: Record<string, string> = {}
  if (r.shortcuts && typeof r.shortcuts === 'object' && !Array.isArray(r.shortcuts)) {
    for (const [k, v] of Object.entries(r.shortcuts as Record<string, unknown>)) {
      if (typeof v === 'string') shortcuts[k] = v
    }
  }

  const framework = compiledCheck(FrameworkSettingsSchema, r.framework)
    ? (r.framework as SiteSettings['framework'])
    : undefined

  const fonts = r.fonts != null ? parseSiteFontsSettings(r.fonts) : undefined

  const csp = parseSiteCspSettings(r.csp)

  return {
    ...(typeof r.metaTitle === 'string' ? { metaTitle: r.metaTitle } : {}),
    ...(typeof r.metaDescription === 'string' ? { metaDescription: r.metaDescription } : {}),
    ...(typeof r.faviconUrl === 'string' ? { faviconUrl: r.faviconUrl } : {}),
    ...(typeof r.language === 'string' ? { language: r.language } : {}),
    framework,
    fonts,
    ...(csp ? { csp } : {}),
    shortcuts,
  }
}

/**
 * Tolerant parse of `settings.csp`: invalid entries are dropped rather than
 * failing the whole settings object, and an allowlist with nothing left in it
 * collapses to `undefined` so an empty object never persists.
 */
function parseSiteCspSettings(raw: unknown): SiteCspSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const scriptOrigins = parseCspOriginList(r.scriptOrigins)
  const connectOrigins = parseCspOriginList(r.connectOrigins)
  if (scriptOrigins.length === 0 && connectOrigins.length === 0) return undefined
  return { scriptOrigins, connectOrigins }
}
