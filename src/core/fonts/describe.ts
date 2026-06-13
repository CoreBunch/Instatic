/**
 * Token digest for the site's font library — the fonts counterpart to
 * `describeFrameworkTokens`. Each font token is reported with the CSS variable
 * the stylesheet emits (`--font-primary`), the `var(--…)` reference to drop
 * into a style value, and the resolved family + fallback so the agent can pick
 * a token by appearance.
 */

import type { SiteFontsSettings } from './schemas'
import { fontTokenCssVariable, fontTokenValueExpr, resolveFontTokenStack, sortFontTokens } from './tokens'

interface FontTokenDescriptor {
  /** Display name, e.g. "Primary". */
  name: string
  /** CSS custom property incl. leading dashes, e.g. "--font-primary". */
  cssVar: string
  /** `var(--…)` expression ready to drop into a `font-family` value. */
  ref: string
  /** Resolved installed family bound to the token, or "" for a fallback-only token. */
  family: string
  /** Full resolved font-family stack, e.g. `"Inter", sans-serif`. */
  stack: string
}

export function describeFontTokens(
  fonts: SiteFontsSettings | null | undefined,
): FontTokenDescriptor[] {
  const tokens = fonts?.tokens ?? []
  if (tokens.length === 0) return []

  const familyById = new Map((fonts?.items ?? []).map((item) => [item.id, item.family]))

  return sortFontTokens(tokens).map((token) => ({
    name: token.name,
    cssVar: fontTokenCssVariable(token.variable),
    ref: fontTokenValueExpr(token.variable),
    family: (token.familyId ? familyById.get(token.familyId) : undefined) ?? '',
    stack: resolveFontTokenStack(token, fonts),
  }))
}
