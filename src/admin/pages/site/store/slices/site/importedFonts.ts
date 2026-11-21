import { nanoid } from 'nanoid'
import type { Draft } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import type { ImportFontFamily, ImportFontToken } from '@core/siteImport'
import type { FontEntry, FontFile, FontToken } from '@core/fonts'
import {
  makeUniqueFontTokenVariable,
  normalizeFontTokenVariable,
  sanitizeFontFallbackStack,
} from '@core/fonts'

/**
 * Merge imported @font-face families into `site.settings.fonts.items`.
 *
 * Imported fonts are custom font entries backed by media-library URLs. A family
 * replaces an existing custom entry of the same name; otherwise it is appended.
 */
export function addImportedFonts(
  site: Draft<SiteDocument>,
  fonts: ImportFontFamily[],
): { id: string; family: string }[] {
  if (fonts.length === 0) return []
  site.settings.fonts ??= { items: [] }
  const lib = site.settings.fonts
  const committed: { id: string; family: string }[] = []

  for (const font of fonts) {
    if (font.files.length === 0) continue
    const id = nanoid()
    const now = Date.now()
    const files: FontFile[] = font.files.map((f) => ({
      variant: f.variant,
      subset: 'latin',
      path: f.src,
      format: f.format,
      ...(f.fontDisplay ? { fontDisplay: f.fontDisplay } : {}),
      ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
    }))
    const variants = Array.from(new Set(files.map((f) => f.variant)))
    const entry: FontEntry = {
      id,
      source: 'custom',
      family: font.family,
      variants,
      subsets: ['latin'],
      files,
      createdAt: now,
      updatedAt: now,
    }

    const familyLower = font.family.toLowerCase()
    const idx = lib.items.findIndex(
      (f) => f.family.toLowerCase() === familyLower && f.source === 'custom',
    )
    if (idx >= 0) lib.items[idx] = entry
    else lib.items.push(entry)
    committed.push({ id, family: font.family })
  }

  return committed
}

/**
 * Merge already-installed font entries into `site.settings.fonts.items`.
 *
 * Google CSS2 imports use the CMS Google-font installer first, which returns
 * the same FontEntry shape as the Typography panel. This helper applies that
 * entry inside the import transaction so the whole import remains one undo
 * step while still using the canonical installed-font model.
 */
export function addInstalledFontEntries(
  site: Draft<SiteDocument>,
  entries: FontEntry[],
): { id: string; family: string }[] {
  if (entries.length === 0) return []
  site.settings.fonts ??= { items: [] }
  const lib = site.settings.fonts
  const committed: { id: string; family: string }[] = []

  for (const entry of entries) {
    const familyLower = entry.family.toLowerCase()
    const sameIdIndex = lib.items.findIndex((font) => font.id === entry.id)
    const sameFamilyIndex = lib.items.findIndex(
      (font) => font.family.toLowerCase() === familyLower && font.source === entry.source,
    )
    const idx = sameIdIndex >= 0 ? sameIdIndex : sameFamilyIndex
    const previousId = idx >= 0 ? lib.items[idx].id : null

    if (idx >= 0) lib.items[idx] = entry
    else lib.items.push(entry)

    if (previousId && previousId !== entry.id) {
      for (const token of lib.tokens ?? []) {
        if (token.familyId === previousId) token.familyId = entry.id
      }
    }
    committed.push({ id: entry.id, family: entry.family })
  }

  return committed
}

/**
 * Merge imported `--font-*` variables into the site's editable font-token list.
 * Collisions get a suffix so imported declarations never overwrite the user's
 * current font-token contract.
 */
export function addImportedFontTokens(
  site: Draft<SiteDocument>,
  tokens: ImportFontToken[],
): { id: string; name: string; variable: string }[] {
  if (tokens.length === 0) return []

  site.settings.fonts ??= { items: [] }
  site.settings.fonts.tokens ??= []
  const settings = site.settings.fonts
  const fontTokens = settings.tokens ?? (settings.tokens = [])
  const committed: { id: string; name: string; variable: string }[] = []
  let maxOrder = fontTokens.reduce((m, t) => Math.max(m, t.order ?? 0), -1)

  const familyIdByName = new Map<string, string>()
  for (const entry of settings.items) {
    familyIdByName.set(entry.family.toLowerCase(), entry.id)
  }

  for (const input of tokens) {
    const variable = makeUniqueFontTokenVariable(
      normalizeFontTokenVariable(input.variable),
      fontTokens,
    )
    const familyId = input.family
      ? familyIdByName.get(input.family.toLowerCase())
      : undefined
    const now = Date.now()
    const token: FontToken = {
      id: nanoid(),
      name: input.name.trim() || variable.replace(/^font-/, ''),
      variable,
      ...(familyId ? { familyId } : {}),
      fallback: sanitizeFontFallbackStack(input.fallback),
      order: (maxOrder += 1),
      createdAt: now,
      updatedAt: now,
    }
    fontTokens.push(token)
    committed.push({ id: token.id, name: token.name, variable })
  }

  return committed
}

/**
 * Overwrite existing font tokens in place (import conflict: overwrite). The
 * existing token's id, name, variable, and order are retained; its family
 * binding and fallback stack are replaced from the imported token so every
 * `var(--<variable>)` reference keeps resolving to the new value.
 *
 * @returns The `{ id, name, variable }` for each overwritten token.
 */
export function overwriteImportedFontTokens(
  site: Draft<SiteDocument>,
  items: { existingTokenId: string; token: ImportFontToken }[],
): { id: string; name: string; variable: string }[] {
  if (items.length === 0) return []

  const fontTokens = site.settings.fonts?.tokens
  if (!fontTokens || fontTokens.length === 0) return []

  const familyIdByName = new Map<string, string>()
  for (const entry of site.settings.fonts?.items ?? []) {
    familyIdByName.set(entry.family.toLowerCase(), entry.id)
  }

  const committed: { id: string; name: string; variable: string }[] = []
  for (const { existingTokenId, token: input } of items) {
    const existing = fontTokens.find((t) => t.id === existingTokenId)
    if (!existing) continue
    const familyId = input.family
      ? familyIdByName.get(input.family.toLowerCase())
      : undefined
    existing.fallback = sanitizeFontFallbackStack(input.fallback)
    if (familyId) existing.familyId = familyId
    else delete existing.familyId
    existing.updatedAt = Date.now()
    committed.push({ id: existing.id, name: existing.name, variable: existing.variable })
  }

  return committed
}
