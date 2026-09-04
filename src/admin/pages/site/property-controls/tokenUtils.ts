/**
 * tokenUtils — shared helpers for "token-aware" CSS property inputs.
 *
 * A `Token` is one entry in a framework variable scale (spacing step `--space-md`,
 * typography step `--text-l`, …). This module centralises:
 *
 *   - The `Token` shape + group-to-tokens expansion.
 *   - Live React hooks that read the active site's framework groups out of
 *     the editor store so callers don't repeat the selector themselves.
 *   - Pure helpers used by both `TokenAwareInput` and any callers that need
 *     to interpret / display values from the same vocabulary
 *     (`resolveTokenValue`, `displayTokenValue`, `looksLikeDirectValue`,
 *     `isLivePreviewable`).
 *
 * The token model is intentionally framework-neutral: all that matters is the
 * (step → varName → valueExpr) triple, so the same input primitive can serve
 * spacing, typography, sizing, color (eventually), and any future scale type.
 */

import { useEditorStore } from '@site/store/store'
import type {
  FrameworkSpacingGroup,
  FrameworkTypographyGroup,
} from '@core/framework-schema'
import { getVariableName } from '@core/framework'

// ---------------------------------------------------------------------------
// Token shape — one suggestion entry shared across all scale-driven controls
// ---------------------------------------------------------------------------

export interface Token {
  /** Step label (e.g. "md", "2xl"). */
  step: string
  /** CSS variable name including leading `--` (e.g. "--space-md"). */
  varName: string
  /** Full value expression to write into a property (e.g. "var(--space-md)"). */
  valueExpr: string
  /** Group display name — shown in autocomplete hints when groups > 1. */
  groupName: string
  /** Naming-convention prefix (e.g. "space"). */
  prefix: string
}

/**
 * Groups have a common shape (a `namingConvention`, a comma-separated `steps`
 * string, an `isDisabled` flag, a `name`). Spacing and typography groups
 * trivially satisfy this so the same expansion works for both.
 */
interface ScaleGroupLike {
  name: string
  namingConvention: string
  steps: string
  isDisabled?: boolean
}

function expandTokensFromGroups(
  groups: ReadonlyArray<ScaleGroupLike> | undefined,
): Token[] {
  if (!groups) return []
  const tokens: Token[] = []
  for (const group of groups) {
    if (group.isDisabled) continue
    const steps = group.steps
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const step of steps) {
      const varName = getVariableName(group.namingConvention, step)
      tokens.push({
        step,
        varName,
        valueExpr: `var(${varName})`,
        groupName: group.name,
        prefix: group.namingConvention,
      })
    }
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Hooks — read framework groups out of the editor store
// ---------------------------------------------------------------------------

/** All enabled spacing tokens for the active site. */
export function useSpacingTokens(): ReadonlyArray<Token> {
  const groups = useEditorStore(
    (s): ReadonlyArray<FrameworkSpacingGroup> | undefined =>
      s.site?.settings.framework?.spacing?.groups,
  )
  return expandTokensFromGroups(groups)
}

/** All enabled typography tokens for the active site. */
export function useTypographyTokens(): ReadonlyArray<Token> {
  const groups = useEditorStore(
    (s): ReadonlyArray<FrameworkTypographyGroup> | undefined =>
      s.site?.settings.framework?.typography?.groups,
  )
  return expandTokensFromGroups(groups)
}

// ---------------------------------------------------------------------------
// Pure helpers — interpret / display values against a token list
// ---------------------------------------------------------------------------

/**
 * Resolve a typed user value into its final CSS expression.
 *
 *   1. Empty → undefined (caller should treat as a clear).
 *   2. CSS function call (`var(...)`, `calc(...)`, etc.) → keep as-is.
 *   3. Matches a token step (case-insensitive) → resolve to `var(--…)`.
 *   4. Number-only string → append `px` (the convention for length-typed
 *      properties; callers that mostly take unitless values can skip this
 *      module entirely).
 *   5. Otherwise → keep as-is (lets users type `auto`, `1rem`, `5%`, …).
 */
export function resolveTokenValue(
  raw: string,
  tokens: ReadonlyArray<Token>,
  /**
   * Unit a bare number gets. `px` for every length; `''` for the few
   * properties where a bare number IS the value (`line-height: 1.5`).
   */
  implicitUnit = 'px',
): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^(var|calc|min|max|clamp|env)\s*\(/i.test(trimmed)) return trimmed

  const match = tokens.find(
    (t) => t.step.toLowerCase() === trimmed.toLowerCase(),
  )
  if (match) return match.valueExpr

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return `${trimmed}${implicitUnit}`
  return trimmed
}

/**
 * Inverse of `resolveTokenValue` — produces the short-form display string
 * for a stored CSS value, so `var(--space-md)` shows as `md`. Falls back
 * to the raw string when no match exists.
 */
export function displayTokenValue(
  value: string | undefined,
  tokens: ReadonlyArray<Token>,
): string {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const varName = extractVarName(trimmed)
  if (varName) {
    const match = tokens.find((t) => t.varName === varName)
    if (match) return match.step
  }
  return trimmed
}

function extractVarName(value: string): string | null {
  const m = value.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)\s*$/)
  return m ? m[1] : null
}

/**
 * Heuristic: does the typed value look like a complete / partial *direct*
 * CSS value (number + unit, keyword like `auto`) rather than a token-step
 * name? Used by autocomplete UIs to hide the suggestion dropdown so direct
 * values can be typed and committed without the menu intercepting clicks.
 */
export function looksLikeDirectValue(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  // Starts with a digit, decimal point, minus, or `+` → numeric value.
  if (/^[\d.\-+]/.test(trimmed)) return true
  // Common CSS keywords for sizing / positioning / typography.
  if (
    /^(auto|none|inherit|initial|unset|revert|max-content|min-content|fit-content|baseline|normal)$/i.test(
      trimmed,
    )
  ) {
    return true
  }
  // CSS functions are also direct values.
  if (/^(var|calc|min|max|clamp|env)\s*\(/i.test(trimmed)) return true
  return false
}

/**
 * Should the current draft be live-previewed on the canvas while the user
 * is still typing?
 *
 *   - empty                     → previewable (means: clear the property)
 *   - exact token match         → previewable (resolves to `var(--…)`)
 *   - number with optional unit → previewable
 *   - whitelisted CSS keyword   → previewable
 *   - CSS function call         → previewable ONLY when parens are balanced
 *   - bare letters              → previewable (browser silently drops garbage)
 *
 * The point is to avoid emitting `var(--spa` (broken syntax) into the engine
 * before the user finishes typing.
 */
export function isLivePreviewable(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return true
  // Reject incomplete CSS function calls — `var(--spa` would write a
  // syntactically broken declaration that the engine rejects loudly.
  if (/^[a-z-]+\s*\(/i.test(trimmed)) {
    if (!trimmed.endsWith(')')) return false
    let depth = 0
    for (const ch of trimmed) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (depth < 0) return false
    }
    return depth === 0
  }
  return true
}
