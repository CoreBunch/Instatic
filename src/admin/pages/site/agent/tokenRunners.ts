/**
 * Browser-side runners for the design-system token write tools:
 * set_color_tokens, set_font_tokens, set_type_scale, set_spacing_scale.
 *
 * Split out of `executor.ts` so each file keeps one responsibility: the
 * executor owns HTML/node/class/page mutations + dispatch; this module owns the
 * framework-token + font-token surface. Each runner validates its raw input
 * with TypeBox (Constraint #272), then dispatches to the editor-store framework
 * / font actions. All four are create-or-update — keyed by color slug, font
 * variable, or scale group — so re-running patches in place.
 *
 * `set_font_tokens` can install a brand-new Google web font: it POSTs to
 * `/admin/api/cms/fonts/install` (downloads the woff2 files server-side, gated
 * by `site.style.edit` via the session cookie), merges the returned `FontEntry`
 * into the library, then binds the token to it.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  SetColorTokensInputSchema,
  SetFontTokensInputSchema,
  SetTypeScaleInputSchema,
  SetSpacingScaleInputSchema,
} from '@core/ai'
import { apiRequest } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { normalizeFrameworkColorSlug } from '@core/framework'
import { FontEntrySchema, normalizeFontTokenVariable } from '@core/fonts'
import type { EditorStore } from '@site/store/types'
import { getAgentStoreApi } from './storeRef'

const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

// The token tool input schemas are the single source of truth in `@core/ai`
// (`src/core/ai/toolSchemas.ts`) — the SAME schemas the server advertises in
// `server/ai/tools/site/writeTools.ts`. Imported above; validated with
// `parseValue` below.

/** Validates the `/admin/api/cms/fonts/install` 201 body. */
const FontInstallResponseSchema = Type.Object({ font: FontEntrySchema })

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/** Build the `--<prefix>-<step>` variable list a scale group generates. */
function generatedScaleVars(namingConvention: string, steps: string): string[] {
  return steps
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((step) => `--${namingConvention}-${step}`)
}

export function runSetColorTokens(rawInput: unknown): AiToolOutput {
  const input = parseValue(SetColorTokensInputSchema, rawInput)
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')
  const results: Array<{ slug: string; ref: string; action: 'created' | 'updated' }> = []

  for (const t of input.tokens) {
    // Create-or-update by normalized slug so re-runs patch the existing token
    // instead of minting `primary-2`.
    const norm = normalizeFrameworkColorSlug(t.slug)
    const existing = getStoreState().site?.settings.framework?.colors.tokens ?? []
    const match = existing.find((e) => normalizeFrameworkColorSlug(e.slug) === norm)
    const patch = {
      lightValue: t.lightValue,
      ...(t.category !== undefined ? { category: t.category } : {}),
      ...(t.darkValue !== undefined ? { darkValue: t.darkValue } : {}),
      ...(t.darkModeEnabled !== undefined ? { darkModeEnabled: t.darkModeEnabled } : {}),
    }
    if (match) {
      store.updateFrameworkColorToken(match.id, patch)
      results.push({ slug: match.slug, ref: `var(--${match.slug})`, action: 'updated' })
    } else {
      const created = store.createFrameworkColorToken({ slug: t.slug, ...patch })
      results.push({ slug: created.slug, ref: `var(--${created.slug})`, action: 'created' })
    }
  }
  return aiToolOk({ tokens: results })
}

export async function runSetFontTokens(rawInput: unknown): Promise<AiToolOutput> {
  const input = parseValue(SetFontTokensInputSchema, rawInput)
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')
  const results: Array<{
    name: string
    variable: string
    ref: string
    installed?: string
    action: 'created' | 'updated'
  }> = []

  for (const t of input.tokens) {
    // Be lenient with model-authored args: the tool description asks for
    // googleFamily XOR familyId, but models sometimes send both after reading
    // existing site state. Installing the named Google family is the clearer
    // intent, so prefer it and ignore the stale/preexisting id.
    let familyId = t.googleFamily ? undefined : t.familyId
    let installed: string | undefined
    if (t.googleFamily) {
      try {
        const { font } = await apiRequest('/admin/api/cms/fonts/install', {
          method: 'POST',
          body: {
            family: t.googleFamily,
            variants: t.variants ?? ['400', '700'],
            subsets: t.subsets ?? ['latin'],
          },
          schema: FontInstallResponseSchema,
          fallbackMessage: 'Font install failed',
        })
        const committed = store.addFont(font)
        familyId = committed.id
        installed = committed.family
      } catch (err) {
        return aiToolError(
          `Failed to install font "${t.googleFamily}": ${getErrorMessage(err, 'install failed')}`,
        )
      }
    }

    // Create-or-update by normalized variable (defaults from the name).
    const desiredVar = normalizeFontTokenVariable(t.variable ?? t.name)
    const existing = getStoreState().site?.settings.fonts?.tokens ?? []
    const match = desiredVar ? existing.find((e) => e.variable === desiredVar) : undefined
    if (match) {
      store.updateFontToken(match.id, {
        name: t.name,
        ...(t.fallback !== undefined ? { fallback: t.fallback } : {}),
        ...(familyId !== undefined ? { familyId } : {}),
      })
      results.push({
        name: t.name,
        variable: match.variable,
        ref: `var(--${match.variable})`,
        ...(installed ? { installed } : {}),
        action: 'updated',
      })
    } else {
      const created = store.createFontToken({
        name: t.name,
        ...(t.variable !== undefined ? { variable: t.variable } : {}),
        ...(t.fallback !== undefined ? { fallback: t.fallback } : {}),
        ...(familyId != null ? { familyId } : {}),
      })
      results.push({
        name: created.name,
        variable: created.variable,
        ref: `var(--${created.variable})`,
        ...(installed ? { installed } : {}),
        action: 'created',
      })
    }
  }
  return aiToolOk({ tokens: results })
}

export function runSetTypeScale(rawInput: unknown): AiToolOutput {
  const input = parseValue(SetTypeScaleInputSchema, rawInput)
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')

  const groups = store.site.settings.framework?.typography?.groups ?? []
  const groupAlias = input.groupId ? normalizeScaleGroupAlias(input.groupId, 'text') : null
  const matchedGroup = input.groupId
    ? groups.find((g) => g.id === input.groupId) ??
      groups.find((g) => g.namingConvention === input.groupId)
    : groups[0]
  let groupId = matchedGroup?.id
  if (input.groupId && !groupId && !groupAlias) {
    return aiToolError(`Typography group not found: ${input.groupId}`)
  }
  let action: 'created' | 'updated' = 'updated'
  if (!groupId) {
    groupId = store.createFrameworkTypographyGroup().id
    action = 'created'
  }

  store.updateFrameworkTypographyGroup(groupId, {
    ...(input.namingConvention !== undefined
      ? { namingConvention: input.namingConvention }
      : action === 'created' && groupAlias
        ? { namingConvention: groupAlias }
        : {}),
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
    ...(input.baseScaleIndex !== undefined ? { baseScaleIndex: input.baseScaleIndex } : {}),
    ...(input.min ? { min: input.min } : {}),
    ...(input.max ? { max: input.max } : {}),
  })

  const group = getStoreState().site?.settings.framework?.typography?.groups.find(
    (g) => g.id === groupId,
  )
  const namingConvention = group?.namingConvention ?? input.namingConvention ?? 'text'
  const steps = group?.steps ?? input.steps ?? ''
  return aiToolOk({
    groupId,
    action,
    namingConvention,
    generatedVars: generatedScaleVars(namingConvention, steps),
  })
}

export function runSetSpacingScale(rawInput: unknown): AiToolOutput {
  const input = parseValue(SetSpacingScaleInputSchema, rawInput)
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')

  const groups = store.site.settings.framework?.spacing?.groups ?? []
  const groupAlias = input.groupId ? normalizeScaleGroupAlias(input.groupId, 'space') : null
  const matchedGroup = input.groupId
    ? groups.find((g) => g.id === input.groupId) ??
      groups.find((g) => g.namingConvention === input.groupId)
    : groups[0]
  let groupId = matchedGroup?.id
  if (input.groupId && !groupId && !groupAlias) {
    return aiToolError(`Spacing group not found: ${input.groupId}`)
  }
  let action: 'created' | 'updated' = 'updated'
  if (!groupId) {
    groupId = store.createFrameworkSpacingGroup().id
    action = 'created'
  }

  store.updateFrameworkSpacingGroup(groupId, {
    ...(input.namingConvention !== undefined
      ? { namingConvention: input.namingConvention }
      : action === 'created' && groupAlias
        ? { namingConvention: groupAlias }
        : {}),
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
    ...(input.baseScaleIndex !== undefined ? { baseScaleIndex: input.baseScaleIndex } : {}),
    ...(input.min ? { min: input.min } : {}),
    ...(input.max ? { max: input.max } : {}),
  })

  const group = getStoreState().site?.settings.framework?.spacing?.groups.find(
    (g) => g.id === groupId,
  )
  const namingConvention = group?.namingConvention ?? input.namingConvention ?? 'space'
  const steps = group?.steps ?? input.steps ?? ''
  return aiToolOk({
    groupId,
    action,
    namingConvention,
    generatedVars: generatedScaleVars(namingConvention, steps),
  })
}

function normalizeScaleGroupAlias(value: string, fallback: 'text' | 'space'): string | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'root') return fallback
  if (normalized === fallback) return fallback
  if (fallback === 'text' && normalized === 'typography') return 'text'
  if (fallback === 'space' && normalized === 'spacing') return 'space'
  return null
}
