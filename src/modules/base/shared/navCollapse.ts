/**
 * Collapse settings shared by base.nav and base.nav-item.
 *
 * The collapse width is a base.nav prop, so base.nav emits the collapse rules
 * for itself and its Menu Items through `instanceCss`, scoped by
 * `[data-instatic-nav-collapse="<width>"]`.
 *
 * Both modules build those rules from a `scope` selector (which nav is
 * collapsed) and an `open` selector (what counts as opened). The canvas runs
 * no module JS and no media queries at the frame's width, so `canvasCss`
 * reuses the same rules with the two canvas selectors below.
 */
export const NAV_COLLAPSE_PRESETS = [640, 768, 1024]
export const NAV_COLLAPSE_DEFAULT = 768

/** Canvas `scope`: NavEditor stamps this on a nav in a frame at or below its collapse width. */
export const NAV_CANVAS_COLLAPSED = '.instatic-nav[data-instatic-nav-canvas="collapsed"]'

/**
 * Canvas `open`: the element or a node inside it is selected. Selection
 * replaces the toggle click, so nested Menu Items stay editable.
 */
export const NAV_CANVAS_OPEN = ':is([data-canvas-selected="true"], :has([data-canvas-selected="true"]))'

/** Rounds to a whole pixel width. Negative or non-numeric values use the default. 0 never collapses. */
export function resolveNavCollapseWidth(value: unknown): number {
  const width = Math.round(Number(value))
  return Number.isFinite(width) && width >= 0 ? width : NAV_COLLAPSE_DEFAULT
}
