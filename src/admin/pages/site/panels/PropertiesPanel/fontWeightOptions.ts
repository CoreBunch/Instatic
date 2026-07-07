import {
  fontFamilyStackForEntry,
  fontTokenCssVariable,
  parseVariant,
  sortFontTokens,
  type FontEntry,
  type FontToken,
  type SiteFontsSettings,
} from '@core/fonts'

export function getFontWeightOptions(
  fontFamilyValue: unknown,
  fonts: SiteFontsSettings | null | undefined,
  fallbackOptions: readonly string[],
): string[] {
  const entry = resolveFontEntryForWeightOptions(fontFamilyValue, fonts)
  const installedWeights = entry ? weightOptionsForEntry(entry) : []
  return installedWeights.length > 0 ? installedWeights : [...fallbackOptions]
}

function resolveFontEntryForWeightOptions(
  fontFamilyValue: unknown,
  fonts: SiteFontsSettings | null | undefined,
): FontEntry | undefined {
  const items = fontItems(fonts)
  if (items.length === 0) return undefined

  const explicitFamily = typeof fontFamilyValue === 'string' ? fontFamilyValue.trim() : ''
  if (explicitFamily) {
    const entry = resolveExplicitFontEntry(explicitFamily, fonts, items)
    if (entry || !isUnsetFontFamilyValue(explicitFamily)) return entry
  }

  return resolveDefaultBodyFontEntry(fonts, items)
}

function resolveExplicitFontEntry(
  fontFamilyValue: string,
  fonts: SiteFontsSettings | null | undefined,
  items: readonly FontEntry[],
): FontEntry | undefined {
  const tokenVariable = readCssVariableReference(fontFamilyValue)
  if (tokenVariable) {
    const token = fontTokens(fonts).find(
      (candidate) => fontTokenCssVariable(candidate.variable) === tokenVariable,
    )
    return token?.familyId ? items.find((entry) => entry.id === token.familyId) : undefined
  }

  const normalizedStack = normalizeCssFamilyStack(fontFamilyValue)
  const exactStackMatch = items.find(
    (entry) => normalizeCssFamilyStack(fontFamilyStackForEntry(entry)) === normalizedStack,
  )
  if (exactStackMatch) return exactStackMatch

  const firstFamily = normalizeCssFamilyName(readFirstCssFamily(fontFamilyValue))
  if (!firstFamily) return undefined
  return items.find((entry) => normalizeCssFamilyName(entry.family) === firstFamily)
}

function resolveDefaultBodyFontEntry(
  fonts: SiteFontsSettings | null | undefined,
  items: readonly FontEntry[],
): FontEntry | undefined {
  const tokens = fontTokens(fonts)
  const bodyToken = tokens[1] ?? tokens[0]
  if (bodyToken?.familyId) {
    const entry = items.find((item) => item.id === bodyToken.familyId)
    if (entry) return entry
  }
  return items[1] ?? items[0]
}

function weightOptionsForEntry(entry: FontEntry): string[] {
  const weights = new Set<number>()
  const variants = [
    ...entry.variants,
    ...entry.files.map((file) => file.variant),
  ]
  for (const variant of variants) {
    const parsed = parseVariant(variant)
    if (parsed) weights.add(parsed.weight)
  }
  return [...weights].sort((a, b) => a - b).map(String)
}

function fontItems(fonts: SiteFontsSettings | null | undefined): readonly FontEntry[] {
  return Array.isArray(fonts?.items) ? fonts.items : []
}

function fontTokens(fonts: SiteFontsSettings | null | undefined): FontToken[] {
  return Array.isArray(fonts?.tokens) ? sortFontTokens(fonts.tokens) : []
}

function readCssVariableReference(value: string): string | undefined {
  const match = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,[^)]+)?\)$/.exec(value)
  return match?.[1]
}

function isUnsetFontFamilyValue(value: string): boolean {
  const normalized = value.toLowerCase()
  return normalized === 'inherit' || normalized === 'initial' || normalized === 'unset' || normalized === 'revert'
}

function readFirstCssFamily(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === quote && trimmed[index - 1] !== '\\') {
        return trimmed.slice(1, index)
      }
    }
    return trimmed.slice(1)
  }
  const comma = trimmed.indexOf(',')
  return (comma === -1 ? trimmed : trimmed.slice(0, comma)).trim()
}

function normalizeCssFamilyStack(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeCssFamilyName(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').toLowerCase()
}
