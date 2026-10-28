/**
 * Representative device viewport height (px) that height-relative viewport
 * units resolve against in the canvas frames (`resolveViewportUnits` from
 * `@core/utils/viewportUnits`; the frame width is the breakpoint width).
 * ~800px matches a typical laptop/phone viewport across every breakpoint
 * width, so `100vh` previews at a believable device height instead of the
 * grown frame height. `iframeBodyReset` also uses it as the body's minimum
 * height so an empty page still fills a screen.
 */
export const CANVAS_VIEWPORT_HEIGHT = 800
