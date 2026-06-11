import {
  bagToCSS,
  compareViewportContextCascade,
  conditionPrelude,
  PUBLISHER_RESET_CSS,
  type ViewportContext,
} from '@core/publisher'
import { generateFrameworkRootCss } from '@core/framework'
import { generateFontsCss } from '@core/fonts'
import { breakpointMediaQuery, styleRuleSelector } from '@core/page-tree'
import type { StyleRule, Condition, ConditionDef } from '@core/page-tree'
import type { SiteFontsSettings } from '@core/fonts'
import type {
  FrameworkColorSettings,
  FrameworkPreferencesSettings,
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from '@core/framework-schema'

function buildCanvasClassCSS(
  classes: Record<string, StyleRule>,
  breakpoints: ViewportContext[],
  conditions: ReadonlyArray<ConditionDef> = [],
  frameworkColors?: FrameworkColorSettings | null,
  frameworkTypography?: FrameworkTypographySettings | null,
  frameworkSpacing?: FrameworkSpacingSettings | null,
  frameworkPreferences?: FrameworkPreferencesSettings | null,
  fonts?: SiteFontsSettings | null,
): string {
  const blocks: string[] = []

  // Publisher reset, identical to what `publishPage()` ships. Each canvas
  // breakpoint frame is its own iframe with its own `<body>`, so we use the
  // unscoped reset (low-specificity `:where(body) { ... }` rules) rather
  // than the legacy `[data-breakpoint-id]`-scoped variant. The unscoped reset
  // matches the published cascade exactly — user CSS like
  // `body { color: var(--color-fg) }` wins over the reset's `:where(body)`
  // baseline, the way it does on the live site. Editor chrome lives outside
  // the iframe so the reset can't leak into the toolbars / panels.
  blocks.push(PUBLISHER_RESET_CSS)

  // Fonts go first (after the reset) so `@font-face` declarations exist before
  // any rule that references the family — browsers tolerate the reverse order,
  // but the ordering keeps generated CSS easier to inspect.
  const fontsCss = generateFontsCss(fonts)
  if (fontsCss) blocks.push(fontsCss)
  const frameworkCss = generateFrameworkRootCss({
    colors: frameworkColors,
    typography: frameworkTypography,
    spacing: frameworkSpacing,
    preferences: frameworkPreferences,
  })
  if (frameworkCss) blocks.push(frameworkCss)

  // Cascade order matches the publisher: rules sorted by `order` ascending so
  // a later, more-specific override appears later in source and wins on equal
  // specificity. See generateClassCSS for the matching publisher invariant.
  const orderedClasses = Object.values(classes).slice().sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : 0
    const bo = typeof b.order === 'number' ? b.order : 0
    return ao - bo
  })

  const breakpointById = new Map<string, { breakpoint: ViewportContext; index: number }>(
    breakpoints.map((bp, index) => [bp.id, { breakpoint: bp, index }]),
  )
  // Condition id → (condition, registry index) for stable ordering.
  const conditionById = new Map<string, { condition: Condition; index: number }>(
    conditions.map((c, index) => [c.id, { condition: c.condition, index }]),
  )

  for (const cls of orderedClasses) {
    const baseDecls = bagToCSS(cls.styles)
    if (baseDecls) {
      blocks.push(`${styleRuleSelector(cls)} {\n${baseDecls}\n}`)
    }

    // Unified contextStyles: a key is either a viewport context or a custom
    // condition. Both emit real @-rule wrappers here so each iframe evaluates
    // the same conditions as the published page.
    const conditionEntries: Array<{ bag: Record<string, unknown>; condition: Condition; index: number }> = []
    const bpEntries: Array<{ bag: Record<string, unknown>; breakpoint: ViewportContext; index: number }> = []
    for (const [contextId, bag] of Object.entries(cls.contextStyles ?? {})) {
      const cond = conditionById.get(contextId)
      if (cond) {
        conditionEntries.push({ bag, condition: cond.condition, index: cond.index })
        continue
      }
      const breakpointEntry = breakpointById.get(contextId)
      if (breakpointEntry) bpEntries.push({ bag, ...breakpointEntry })
    }

    conditionEntries.sort((a, b) => a.index - b.index)
    for (const { bag, condition } of conditionEntries) {
      const decls = bagToCSS(bag)
      if (!decls) continue
      const prelude = conditionPrelude(condition)
      if (!prelude) continue
      blocks.push(`${prelude} {\n  ${styleRuleSelector(cls)} {\n${decls}\n  }\n}`)
    }

    bpEntries.sort(compareViewportContextCascade)
    for (const { bag, breakpoint } of bpEntries) {
      const decls = bagToCSS(bag)
      if (!decls) continue
      const prelude = conditionPrelude({ kind: 'media', query: breakpointMediaQuery(breakpoint) })
      if (!prelude) continue
      blocks.push(`${prelude} {\n  ${styleRuleSelector(cls)} {\n${decls}\n  }\n}`)
    }
  }

  return blocks.join('\n\n')
}

type CanvasClassCssGenerator = typeof buildCanvasClassCSS

/**
 * Wrap the registry-CSS generator in a single-slot identity memo.
 *
 * Every breakpoint-frame `ClassStyleInjector` regenerates this CSS with the
 * SAME store-snapshot inputs in the same commit — the generation is pure and
 * all inputs are Mutative-immutable, so comparing the 8 argument identities
 * is exact: frames 2..N (and any re-run with unchanged inputs) return the
 * cached string instead of re-sorting and re-emitting the whole registry.
 *
 * The factory shape exists so tests can inject a counting generator; runtime
 * code uses the bound `generateCanvasClassCSS` singleton below.
 */
export function createCanvasClassCssMemo(
  generate: CanvasClassCssGenerator = buildCanvasClassCSS,
): CanvasClassCssGenerator {
  let lastInputs: readonly unknown[] | null = null
  let lastCss = ''
  return (
    classes,
    breakpoints,
    conditions = [],
    frameworkColors,
    frameworkTypography,
    frameworkSpacing,
    frameworkPreferences,
    fonts,
  ) => {
    const inputs = [
      classes,
      breakpoints,
      conditions,
      frameworkColors,
      frameworkTypography,
      frameworkSpacing,
      frameworkPreferences,
      fonts,
    ]
    const prev = lastInputs
    if (prev && inputs.every((value, i) => Object.is(value, prev[i]))) {
      return lastCss
    }
    lastCss = generate(
      classes,
      breakpoints,
      conditions,
      frameworkColors,
      frameworkTypography,
      frameworkSpacing,
      frameworkPreferences,
      fonts,
    )
    lastInputs = inputs
    return lastCss
  }
}

/**
 * Generate the canvas class-registry CSS (publisher reset + fonts +
 * framework root CSS + every style rule with its breakpoint/condition
 * overrides). Identity-memoized — see `createCanvasClassCssMemo`.
 */
export const generateCanvasClassCSS: CanvasClassCssGenerator = createCanvasClassCssMemo()

/**
 * Generate a higher-specificity preview rule for a single class, used by
 * the canvas style injector while a user is hovering a suggestion. The
 * doubled class selector (`.foo.foo`) wins over any base / breakpoint
 * rule emitted by `generateCanvasClassCSS`, without committing the
 * change to the document or pushing a history entry.
 */
export function generatePreviewClassCSS(
  cls: StyleRule,
  preview: { breakpointId?: string | null; styles: Record<string, unknown> },
): string {
  const decls = bagToCSS(preview.styles)
  if (!decls) return ''
  const selector = styleRuleSelector(cls)
  const doubled = `${selector}${selector}`
  if (!preview.breakpointId) {
    return `${doubled} {\n${decls}\n}`
  }
  return `[data-breakpoint-id="${escapeCssAttribute(preview.breakpointId)}"] ${doubled} {\n${decls}\n}`
}

/**
 * Optional in-flight edit overlaid onto the forced state preview so dragging a
 * control updates it live. `contextId` is the breakpoint/condition the edit
 * targets (`null` for the base context).
 */
export interface ForcedStateInflight {
  contextId: string | null
  styles: Record<string, unknown>
}

/**
 * CSS that force-previews a *state* rule onto a single node, regardless of
 * whether the state (`:hover`/`:focus`/…) is actually active.
 *
 * Selecting a state pill in the picker can't toggle a real `:hover` (there's no
 * DOM API for it), so we paint the rule's declarations directly onto the
 * selected element. The `[data-node-id]` attribute selector is doubled for
 * specificity — the same trick `generatePreviewClassCSS` uses — so the forced
 * state wins over the element's base class rules while leaving unspecified
 * properties to fall through.
 *
 * Crucially this mirrors `generateCanvasClassCSS`'s per-rule emission: the base
 * styles AND every `contextStyles` override are emitted under their real
 * `@media`/`@container`/`@supports` preludes. Because each canvas frame is an
 * iframe at a fixed width, those queries evaluate per-frame exactly as on the
 * published page — so a hover override that only applies at a breakpoint is
 * previewed only in that breakpoint's frame.
 */
export function generateForcedStateCSS(
  nodeId: string,
  rule: StyleRule,
  breakpoints: ViewportContext[],
  conditions: ReadonlyArray<ConditionDef> = [],
  inflight?: ForcedStateInflight | null,
): string {
  const rawSelector = `[data-node-id="${escapeCssAttribute(nodeId)}"]`
  const selector = `${rawSelector}${rawSelector}`
  const blocks: string[] = []

  const baseStyles = inflight && inflight.contextId === null
    ? { ...rule.styles, ...inflight.styles }
    : rule.styles
  const baseDecls = bagToCSS(baseStyles)
  if (baseDecls) blocks.push(`${selector} {\n${baseDecls}\n}`)

  const breakpointById = new Map<string, { breakpoint: ViewportContext; index: number }>(
    breakpoints.map((bp, index) => [bp.id, { breakpoint: bp, index }]),
  )
  const conditionById = new Map<string, { condition: Condition; index: number }>(
    conditions.map((c, index) => [c.id, { condition: c.condition, index }]),
  )

  // Merge any in-flight edit into the context it targets so a brand-new
  // context override previews live too.
  const contextStyles: Record<string, Record<string, unknown>> = { ...(rule.contextStyles ?? {}) }
  if (inflight && inflight.contextId !== null) {
    contextStyles[inflight.contextId] = { ...(contextStyles[inflight.contextId] ?? {}), ...inflight.styles }
  }

  const conditionEntries: Array<{ bag: Record<string, unknown>; condition: Condition; index: number }> = []
  const bpEntries: Array<{ bag: Record<string, unknown>; breakpoint: ViewportContext; index: number }> = []
  for (const [contextId, bag] of Object.entries(contextStyles)) {
    const cond = conditionById.get(contextId)
    if (cond) {
      conditionEntries.push({ bag, condition: cond.condition, index: cond.index })
      continue
    }
    const breakpointEntry = breakpointById.get(contextId)
    if (breakpointEntry) bpEntries.push({ bag, ...breakpointEntry })
  }

  conditionEntries.sort((a, b) => a.index - b.index)
  for (const { bag, condition } of conditionEntries) {
    const decls = bagToCSS(bag)
    if (!decls) continue
    const prelude = conditionPrelude(condition)
    if (!prelude) continue
    blocks.push(`${prelude} {\n  ${selector} {\n${decls}\n  }\n}`)
  }

  bpEntries.sort(compareViewportContextCascade)
  for (const { bag, breakpoint } of bpEntries) {
    const decls = bagToCSS(bag)
    if (!decls) continue
    const prelude = conditionPrelude({ kind: 'media', query: breakpointMediaQuery(breakpoint) })
    if (!prelude) continue
    blocks.push(`${prelude} {\n  ${selector} {\n${decls}\n  }\n}`)
  }

  return blocks.join('\n\n')
}

function escapeCssAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
