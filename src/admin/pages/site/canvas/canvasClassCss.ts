import {
  bagToCSS,
  createStyleRuleCssEmitter,
  generateClassCSS,
  PUBLISHER_RESET_CSS,
  type ViewportContext,
  type ResponsiveCssOptions,
} from '@core/publisher'
import { generateFrameworkRootCss } from '@core/framework'
import { generateFontsCss } from '@core/fonts'
import { styleRuleSelector } from '@core/page-tree'
import type { StyleRule, ConditionDef } from '@core/page-tree'
import type { SiteFontsSettings } from '@core/fonts'
import type {
  FrameworkColorSettings,
  FrameworkPreferencesSettings,
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from '@core/framework-schema'

interface CanvasResponsiveCssOptions extends ResponsiveCssOptions {
  mediaSignature?: string
}

function buildCanvasClassCSS(
  classes: Record<string, StyleRule>,
  breakpoints: ViewportContext[],
  conditions: ReadonlyArray<ConditionDef> = [],
  frameworkColors?: FrameworkColorSettings | null,
  frameworkTypography?: FrameworkTypographySettings | null,
  frameworkSpacing?: FrameworkSpacingSettings | null,
  frameworkPreferences?: FrameworkPreferencesSettings | null,
  fonts?: SiteFontsSettings | null,
  responsiveOptions: CanvasResponsiveCssOptions = {},
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

  // The registry CSS is the publisher's own generator — the canvas ships the
  // exact bytes a publish would (rule order, condition/viewport cascade, and
  // sanitized raw @keyframes rules included), so the preview cannot drift
  // from the published output.
  const classCss = generateClassCSS(classes, breakpoints, conditions, responsiveOptions)
  if (classCss) blocks.push(classCss)

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
    responsiveOptions = {},
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
      responsiveOptions.mediaSignature,
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
      responsiveOptions,
    )
    lastInputs = inputs
    return lastCss
  }
}

/**
 * Generate the canvas class-registry CSS (publisher reset + fonts +
 * framework root CSS + the publisher's `generateClassCSS` output).
 * Identity-memoized — see `createCanvasClassCssMemo`.
 */
export const generateCanvasClassCSS: CanvasClassCssGenerator = createCanvasClassCssMemo()

const EMPTY_CONTAINER_PLACEHOLDER_SELECTOR = '[data-canvas-module-placeholder]'

function ruleHasAuthoredDeclarations(rule: StyleRule): boolean {
  if (Object.keys(rule.styles).length > 0) return true
  return Object.values(rule.contextStyles).some((styles) => Object.keys(styles).length > 0)
}

/**
 * Hide the editor-only empty-container placeholder when an ambient selector
 * styles the authored element.
 *
 * Class-assigned and inline-styled empty containers suppress the placeholder
 * in `ContainerEditor` because that styling is present in the node props.
 * Ambient rules attach only through selector matching, so the component cannot
 * see them. These canvas-only rules let the browser perform the same selector
 * matching it already performs for the authored CSS, including descendant,
 * sibling, attribute, and state selectors.
 *
 * `:is()` keeps comma-separated selector lists scoped as one subject before
 * the direct-child placeholder suffix is added. `:empty` is rewritten against
 * the editor-only placeholder child so selectors authored for a genuinely
 * empty published element still suppress the canvas affordance.
 */
export function generateAmbientPlaceholderSuppressionCSS(
  rules: Record<string, StyleRule>,
): string {
  const selectors = Object.values(rules)
    .filter((rule) =>
      rule.kind === 'ambient' &&
      !rule.rawCss &&
      ruleHasAuthoredDeclarations(rule)
    )
    .map((rule) =>
      styleRuleSelector(rule).replace(
        /:empty\b/g,
        `:has(> ${EMPTY_CONTAINER_PLACEHOLDER_SELECTOR}:only-child)`,
      )
    )

  if (selectors.length === 0) return ''

  return selectors
    .map(
      (selector) =>
        `:is(${selector}) > ${EMPTY_CONTAINER_PLACEHOLDER_SELECTOR} { display: none; }`,
    )
    .join('\n')
}

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
  responsiveOptions: ResponsiveCssOptions = {},
): string {
  const priorities = preview.breakpointId
    ? cls.contextStylePriorities?.[preview.breakpointId]
    : cls.stylePriorities
  const decls = bagToCSS(preview.styles, responsiveOptions, priorities)
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
interface ForcedStateInflight {
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
 * The emission itself is the publisher's `createStyleRuleCssEmitter`: the base
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
  responsiveOptions: ResponsiveCssOptions = {},
): string {
  const rawSelector = `[data-node-id="${escapeCssAttribute(nodeId)}"]`
  const selector = `${rawSelector}${rawSelector}`

  const baseStyles = inflight && inflight.contextId === null
    ? { ...rule.styles, ...inflight.styles }
    : rule.styles

  // Merge any in-flight edit into the context it targets so a brand-new
  // context override previews live too.
  const contextStyles: Record<string, Record<string, unknown>> = { ...(rule.contextStyles ?? {}) }
  if (inflight && inflight.contextId !== null) {
    contextStyles[inflight.contextId] = { ...(contextStyles[inflight.contextId] ?? {}), ...inflight.styles }
  }

  const emitRule = createStyleRuleCssEmitter(breakpoints, conditions, responsiveOptions)
  return emitRule(selector, {
    styles: baseStyles,
    stylePriorities: rule.stylePriorities,
    contextStyles,
    contextStylePriorities: rule.contextStylePriorities,
  }).join('\n\n')
}

function escapeCssAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
