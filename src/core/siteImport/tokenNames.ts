/**
 * tokenNames — settle the name each imported design token is emitted under.
 *
 * The store normalises every token name: colour slugs with
 * `normalizeFrameworkColorSlug`, font variables with `normalizeFontTokenVariable`
 * (lowercase, every run of non-alphanumerics collapsed to one `-`). So an
 * authored `--brand---neutral--700` is emitted as `--brand-neutral-700` and
 * `--font-Heading` as `--font-heading`. The importer settles those names at plan
 * time and returns the `authored → emitted` map (names without `--`) that
 * `rewriteImportVarRefs` applies to the imported `var()` references and
 * declarations.
 *
 * Colour and font tokens share one CSS namespace, so both kinds are settled
 * together against one set of claimed names.
 */

import { normalizeFrameworkColorSlug } from '@core/framework'
import { normalizeFontTokenVariable } from '@core/fonts'
import type { ImportColorToken, ImportFontToken } from './types'
import { tokenNameFromVariable } from './fontTokens'

interface NamedEntry {
  name: string
  normalize: (name: string) => string
}

/**
 * Give each imported colour and font token its emitted name.
 *
 * A name already in emitted form keeps it. Any other takes its normalised form,
 * or the first free `-2`, `-3`, ... suffix when that is taken by another token
 * of either kind or by `declared`, the other custom properties the imported CSS
 * declares. A token's own authored name in `declared` (an override such as
 * `.dark { --bg: … }`) is not a conflict. Colours are settled before fonts.
 */
export function normalizeImportedTokens(
  tokens: { colors: ImportColorToken[]; fonts: ImportFontToken[] },
  declared: Set<string> = new Set(),
): { colors: ImportColorToken[]; fonts: ImportFontToken[]; renames: Map<string, string> } {
  const entries: NamedEntry[] = [
    ...tokens.colors.map((token) => ({ name: token.slug, normalize: normalizeFrameworkColorSlug })),
    ...tokens.fonts.map((token) => ({ name: token.variable, normalize: normalizeFontTokenVariable })),
  ]
  const { emitted, renames } = assignEmittedNames(entries, declared)
  const fontOffset = tokens.colors.length

  const colors = tokens.colors.map((token, i) =>
    emitted[i] === token.slug ? token : { ...token, slug: emitted[i] },
  )
  const fonts = tokens.fonts.map((token, i) => {
    const variable = emitted[fontOffset + i]
    return variable === token.variable
      ? token
      : { ...token, name: tokenNameFromVariable(variable), variable }
  })
  return { colors, fonts, renames }
}

function assignEmittedNames(
  entries: NamedEntry[],
  declared: Set<string>,
): { emitted: string[]; renames: Map<string, string> } {
  const own = new Set(entries.map((entry) => entry.name))
  const claimed = new Set([...declared].filter((name) => !own.has(name)))
  const kept = new Set<string>()
  for (const { name, normalize } of entries) {
    if (normalize(name) === name) {
      kept.add(name)
      claimed.add(name)
    }
  }

  const renames = new Map<string, string>()
  const emitted = entries.map(({ name, normalize }) => {
    if (kept.has(name)) return name
    const base = normalize(name)
    let next = base
    for (let suffix = 2; claimed.has(next); suffix++) next = `${base}-${suffix}`
    claimed.add(next)
    renames.set(name, next)
    return next
  })
  return { emitted, renames }
}
