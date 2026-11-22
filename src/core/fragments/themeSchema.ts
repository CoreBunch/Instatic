/**
 * Site theme — a site's design variables without its content.
 *
 * A theme carries the colour tokens (full definitions: light and dark values,
 * the dark-mode flag, generation flags), the font tokens with the font
 * families they bind to, the typography and spacing scale groups (named by
 * their `namingConvention`), and the custom properties the site's root-scope
 * ambient rules define (radius, leading, container widths…). Custom font
 * files and any media a custom property points at travel as `media`, in the
 * same shape and package layout as a fragment's (`media/<sha256>.<ext>`).
 *
 * Fragments never overwrite what a site has; applying a theme is the one
 * place where overwriting is the point (`planThemeApply`).
 *
 * `parseSiteTheme` is the boundary: TypeBox for the shape, then the
 * invariants JSON Schema cannot express (unique slugs, variables, scale
 * names and ids; font tokens bind to a family the theme carries).
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { compiledSafeParseValue } from '@core/utils/typeboxCompiler'
import {
  FrameworkColorTokenSchema,
  FrameworkSpacingGroupSchema,
  FrameworkTypographyGroupSchema,
} from '@core/framework-schema'
import { normalizeFrameworkColorSlug } from '@core/framework'
import { FontEntrySchema, FontTokenSchema, normalizeFontTokenVariable } from '@core/fonts'
import { FragmentMediaSchema, FragmentOriginSchema, FragmentParseError } from './schema'

export const SITE_THEME_FORMAT = 'instatic-theme'
export const SITE_THEME_VERSION = 1

export const SiteThemeSchema = Type.Object({
  format: Type.Literal(SITE_THEME_FORMAT),
  version: Type.Literal(SITE_THEME_VERSION),
  origin: Type.Optional(FragmentOriginSchema),
  /** Every colour token, generation flags included, in the source's order. */
  colors: Type.Array(FrameworkColorTokenSchema),
  /** Every font token. A `familyId` names one of `fontFamilies`. */
  fontTokens: Type.Array(FontTokenSchema),
  /** The font library entries the tokens bind to. */
  fontFamilies: Type.Array(FontEntrySchema),
  /** Typography scale groups, matched on apply by `namingConvention`. */
  typography: Type.Array(FrameworkTypographyGroupSchema),
  /** Spacing scale groups, matched on apply by `namingConvention`. */
  spacing: Type.Array(FrameworkSpacingGroupSchema),
  /** `--name` → value from the source's root-scope ambient rules (`:root`, `html`, `body`). */
  customProperties: Type.Record(Type.String({ pattern: '^--' }), Type.String(), { additionalProperties: false }),
  /** Custom font files and media custom properties reference. */
  media: Type.Array(FragmentMediaSchema),
})

export type SiteTheme = Static<typeof SiteThemeSchema>

/**
 * Validate an untrusted value as a `SiteTheme`. Throws `FragmentParseError`
 * on the first problem; returns the typed theme otherwise.
 */
export function parseSiteTheme(value: unknown): SiteTheme {
  const result = compiledSafeParseValue(SiteThemeSchema, value)
  if (!result.ok) {
    const first = result.errors[0]
    throw new FragmentParseError(first?.path || 'theme', first?.message ?? 'Invalid theme')
  }
  const theme = result.value
  assertUnique('colors', theme.colors.map((t) => normalizeFrameworkColorSlug(t.slug)), 'colour slugs')
  assertUnique('fontTokens', theme.fontTokens.map((t) => normalizeFontTokenVariable(t.variable)), 'font token variables')
  assertUnique('fontFamilies', theme.fontFamilies.map((f) => f.id), 'font family ids')
  assertUnique('typography', theme.typography.map((g) => g.namingConvention), 'typography scale names')
  assertUnique('spacing', theme.spacing.map((g) => g.namingConvention), 'spacing scale names')
  assertUnique('media', theme.media.map((m) => m.id), 'media ids')
  const familyIds = new Set(theme.fontFamilies.map((f) => f.id))
  theme.fontTokens.forEach((token, index) => {
    if (token.familyId && !familyIds.has(token.familyId)) {
      throw new FragmentParseError(`fontTokens.${index}.familyId`, `family "${token.familyId}" is not in fontFamilies`)
    }
  })
  return theme
}

function assertUnique(path: string, values: string[], what: string): void {
  if (new Set(values).size !== values.length) throw new FragmentParseError(path, `${what} must be unique`)
}
