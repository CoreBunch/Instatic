/**
 * Font role tokens: the three font tokens every new site starts with.
 *
 *   • `font-heading` ("Heading"): headings and display type
 *   • `font-body`    ("Body"): running text
 *   • `font-mono`    ("Mono"): code, data and mono labels
 *
 * Content written against these variables (imported pages, copied sections,
 * AI output) renders in any site, because every site that has them binds the
 * same names. They are seeded fallback-only (no `familyId`) with system
 * stacks, so a new site renders without downloading anything; the user binds
 * real families later in the Fonts panel.
 *
 * Seeded by `createNewSiteSettings` (`@core/page-tree`) for brand-new sites and
 * added by the Core Framework preset (`applyFrameworkPreset`) to sites that
 * lack them. Existing sites are never migrated. Site import overwrites a role
 * token that is still an untouched seed (`isUntouchedFontRoleToken`).
 */

import { nanoid } from 'nanoid'
import type { FontToken, SiteFontsSettings } from './schemas'
import { normalizeFontTokenVariable, sanitizeFontFallbackStack } from './tokenStrings'

/** System sans-serif stack, stored in its sanitized (unquoted) form. */
const SYSTEM_SANS_STACK = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
const SYSTEM_MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

interface FontRole {
  name: string
  variable: string
  fallback: string
}

export const FONT_ROLES: readonly FontRole[] = [
  { name: 'Heading', variable: 'font-heading', fallback: SYSTEM_SANS_STACK },
  { name: 'Body', variable: 'font-body', fallback: SYSTEM_SANS_STACK },
  { name: 'Mono', variable: 'font-mono', fallback: SYSTEM_MONO_STACK },
]

function roleToken(role: FontRole, order: number, now: number): FontToken {
  return {
    id: nanoid(),
    name: role.name,
    variable: role.variable,
    fallback: role.fallback,
    order,
    createdAt: now,
    updatedAt: now,
  }
}

/** Fresh fallback-only tokens for every font role, in role order. */
export function buildFontRoleTokens(): FontToken[] {
  const now = Date.now()
  return FONT_ROLES.map((role, index) => roleToken(role, index, now))
}

/**
 * Add the font role tokens a site is missing, matching by variable. Tokens the
 * site already has (including a customized `font-heading`) are left exactly as
 * they are. Returns the input object itself when nothing is missing, so callers
 * can skip a no-op write by reference comparison.
 */
export function mergeFontRoleTokens(fonts: SiteFontsSettings | undefined): SiteFontsSettings {
  const existing = fonts?.tokens ?? []
  const have = new Set(existing.map((token) => normalizeFontTokenVariable(token.variable)))
  const missing = FONT_ROLES.filter((role) => !have.has(role.variable))
  if (fonts && missing.length === 0) return fonts

  const now = Date.now()
  let order = existing.reduce((max, token) => Math.max(max, token.order + 1), 0)
  return {
    items: fonts?.items ?? [],
    tokens: [...existing, ...missing.map((role) => roleToken(role, order++, now))],
  }
}

/**
 * True when `token` is a role token exactly as it was seeded: a `FONT_ROLES`
 * variable with the seeded name and fallback stack and no bound family. A role
 * token the user has bound, renamed or re-stacked is no longer a seed. Site
 * import overwrites an untouched seed instead of renaming the imported token.
 */
export function isUntouchedFontRoleToken(
  token: Pick<FontToken, 'name' | 'variable' | 'familyId' | 'fallback'>,
): boolean {
  if (token.familyId) return false
  const variable = normalizeFontTokenVariable(token.variable)
  const role = FONT_ROLES.find((r) => r.variable === variable)
  if (!role) return false
  return token.name === role.name && sanitizeFontFallbackStack(token.fallback) === role.fallback
}

/**
 * Name to pre-fill when the user adds a font token: the first role the site
 * does not have yet, else a generic accent name.
 */
export function suggestFontTokenName(tokens: ReadonlyArray<Pick<FontToken, 'variable'>>): string {
  const have = new Set(tokens.map((token) => normalizeFontTokenVariable(token.variable)))
  return FONT_ROLES.find((role) => !have.has(role.variable))?.name ?? 'Accent'
}
