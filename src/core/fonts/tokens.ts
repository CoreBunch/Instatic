import type { FontEntry, FontToken, SiteFontsSettings } from './schemas'

export function normalizeFontTokenVariable(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/^-+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized) return ''
  return normalized.startsWith('font-') ? normalized : `font-${normalized}`
}

export function fontTokenCssVariable(variable: string): string {
  const normalized = normalizeFontTokenVariable(variable)
  return normalized ? `--${normalized}` : ''
}

export function fontTokenValueExpr(variable: string): string {
  const cssVariable = fontTokenCssVariable(variable)
  return cssVariable ? `var(${cssVariable})` : ''
}

export function suggestFontTokenVariable(label: string): string {
  return normalizeFontTokenVariable(label || 'font')
}

export function makeUniqueFontTokenVariable(
  desired: string,
  tokens: ReadonlyArray<Pick<FontToken, 'id' | 'variable'>>,
  ignoreTokenId?: string,
): string {
  const base = normalizeFontTokenVariable(desired) || 'font-family'
  const used = new Set(
    tokens
      .filter((token) => token.variable && token.id !== ignoreTokenId)
      .map((token) => normalizeFontTokenVariable(token.variable)),
  )
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}-${index}`)) index++
  return `${base}-${index}`
}

export function isDuplicateFontTokenVariable(
  variable: string,
  tokens: ReadonlyArray<FontToken>,
  ignoreTokenId?: string,
): boolean {
  const normalized = normalizeFontTokenVariable(variable)
  if (!normalized) return false
  return tokens.some((token) => token.id !== ignoreTokenId && normalizeFontTokenVariable(token.variable) === normalized)
}

function fallbackForFontCategory(category: string | undefined): string {
  switch ((category ?? '').toLowerCase()) {
    case 'serif':
      return 'serif'
    case 'monospace':
      return 'monospace'
    case 'handwriting':
      return 'cursive'
    case 'display':
    case 'sans serif':
    case 'sans-serif':
    default:
      return 'sans-serif'
  }
}

export function defaultFontTokenFallback(entry: FontEntry | undefined): string {
  return fallbackForFontCategory(entry?.category)
}

export function sanitizeFontFallbackStack(raw: string | undefined): string {
  const cleaned = (raw ?? '')
    .split(',')
    .map((part) => part.trim().replace(/["\\\n\r<>;{}]/g, ''))
    .filter((part) => part.length > 0)
  if (cleaned.length === 0) return 'sans-serif'
  return cleaned.join(', ')
}

function escapeCssString(value: string): string {
  return value.replace(/["\\\n\r<>]/g, '')
}

export function fontFamilyStackForEntry(entry: FontEntry): string {
  return `"${escapeCssString(entry.family)}", ${fallbackForFontCategory(entry.category)}`
}

export function resolveFontTokenStack(
  token: FontToken,
  fonts: SiteFontsSettings | null | undefined,
): string {
  const fallback = sanitizeFontFallbackStack(token.fallback)
  const entry = token.familyId
    ? fonts?.items.find((item) => item.id === token.familyId)
    : undefined
  if (!entry) return fallback
  return `"${escapeCssString(entry.family)}", ${fallback}`
}

export function sortFontTokens(tokens: ReadonlyArray<FontToken>): FontToken[] {
  return [...tokens].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}
