/**
 * Resolve CSS viewport-length units to fixed pixels.
 *
 * Both preview surfaces show a page in an iframe whose height tracks its
 * content: the canvas breakpoint frames (`IframeFrameSurface`) and the merge
 * review's page frames (`PageCompare`). Inside such a frame the
 * height-relative units (`vh`, `vb`, `vmin`, `vmax`, and the small/large/
 * dynamic variants) are measured against the frame's OWN height, so
 * `min-height: 100vh` feeds straight back into the height the frame is
 * growing to: the frame sizes to its content → `vh` recomputes larger → the
 * content grows → the frame grows again, until whatever ceiling stops it (a
 * `88vh` hero once measured ~32,000px).
 *
 * Resolving every viewport unit against a fixed device viewport breaks the
 * loop: content height no longer depends on frame height, so the frame
 * settles at the real content height in one pass and `vh` renders at a
 * device-like size. Width-relative units are resolved too, so mixed units
 * (`vmin`/`vmax`) stay dimensionally consistent.
 *
 * This is a PREVIEW-ONLY transform; published pages keep real viewport
 * units, resolved against the visitor's browser. Only numeric unit values
 * change: selectors are never touched, so combinators and structural
 * pseudo-classes keep matching the same elements, and comments, quoted
 * strings, and `url(...)` tokens pass through verbatim. `vi`/`vb` are
 * treated as inline = horizontal and block = vertical (`horizontal-tb`);
 * vertical writing modes would resolve them to the swapped axis, an
 * accepted trade-off that keeps this a pure string pass.
 */

export interface Viewport {
  /** Frame width in px: the basis for width-relative units (`vw`, `vi`). */
  width: number
  /** Frame viewport height in px: the basis for height-relative units. */
  height: number
}

// Single-pass scanner. The leading branches consume regions where a
// `<number><unit>` pattern must NOT be rewritten (block comments, quoted
// strings, and `url(...)` tokens) and are passed through verbatim. The final
// branch captures an actual viewport-unit length: a number (group 1)
// followed by a unit (group 2), guarded so it cannot match inside an
// identifier (`.h100vh`, `--gap-1vh`) or a longer unit/number tail.
//
// Unit alternation is ordered longest-first so e.g. `vmin` wins over `vi`.
const VIEWPORT_UNIT_SCAN =
  /\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\((?:[^)\\]|\\.)*\)|(?<![\w.#-])(-?(?:\d*\.\d+|\d+))(svmin|lvmin|dvmin|svmax|lvmax|dvmax|vmin|vmax|svw|lvw|dvw|svh|lvh|dvh|svi|lvi|dvi|svb|lvb|dvb|vw|vh|vi|vb)(?![\w%-])/gi

function unitBasisPx(unit: string, viewport: Viewport): number {
  switch (unit.toLowerCase()) {
    case 'vw':
    case 'svw':
    case 'lvw':
    case 'dvw':
    case 'vi':
    case 'svi':
    case 'lvi':
    case 'dvi':
      return viewport.width
    case 'vmin':
    case 'svmin':
    case 'lvmin':
    case 'dvmin':
      return Math.min(viewport.width, viewport.height)
    case 'vmax':
    case 'svmax':
    case 'lvmax':
    case 'dvmax':
      return Math.max(viewport.width, viewport.height)
    // vh / vb and the small/large/dynamic variants: the height axis.
    default:
      return viewport.height
  }
}

/**
 * Rewrite every CSS viewport-length unit in `css` to a fixed `px` value based
 * on `viewport`. Comments, strings, and `url()` tokens are left untouched.
 */
export function resolveViewportUnits(css: string, viewport: Viewport): string {
  if (!css) return css
  return css.replace(VIEWPORT_UNIT_SCAN, (match, num: string | undefined, unit: string | undefined) => {
    // Protected region (comment / string / url): group captures are undefined.
    if (num === undefined || unit === undefined) return match
    const px = (parseFloat(num) / 100) * unitBasisPx(unit, viewport)
    // Trim float noise: keep up to 3 decimals, drop trailing zeros.
    return `${parseFloat(px.toFixed(3))}px`
  })
}

/**
 * `resolveViewportUnits` over every `<style>` block and `style` attribute of
 * a rendered document, for a frame that shows finished HTML rather than
 * injecting CSS of its own.
 */
export function resolveViewportUnitsInHtml(html: string, viewport: Viewport): string {
  return html
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_match, open: string, css: string, close: string) =>
      open + resolveViewportUnits(css, viewport) + close)
    .replace(/(\sstyle=")([^"]*)(")/gi, (_match, open: string, css: string, close: string) =>
      open + resolveViewportUnits(css, viewport) + close)
}
