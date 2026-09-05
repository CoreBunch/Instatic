/**
 * Resolve viewport units in a rendered page against a fixed desktop
 * viewport.
 *
 * The merge review shows a page in an iframe as tall as the document, so
 * the frame has no real screen height: `height: 70vh` would measure itself
 * against the document, grow the document, and be measured again, until
 * the frame's ceiling. A visitor's browser resolves the same rule against
 * its screen. This does the same against the review's viewport, in every
 * `<style>` block and `style` attribute, so the frame shows the page the
 * way a desktop screen would, only captured full length.
 */

/** `62vh`, `calc(100dvh - 80px)`, `5.8vw`, `10vmin`; never `--gap-1vh`. */
const VIEWPORT_UNIT = /(-?(?:\d+\.?\d*|\.\d+))(?:d|s|l)?v(h|w|min|max)\b/gi

export interface ReviewViewport {
  width: number
  height: number
}

function toPx(value: number, axis: string, viewport: ReviewViewport): string {
  const base =
    axis === 'h' ? viewport.height
    : axis === 'w' ? viewport.width
    : axis === 'min' ? Math.min(viewport.width, viewport.height)
    : Math.max(viewport.width, viewport.height)
  const px = (value * base) / 100
  return `${Math.round(px * 100) / 100}px`
}

function resolveCss(css: string, viewport: ReviewViewport): string {
  return css.replace(VIEWPORT_UNIT, (match: string, value: string, axis: string, offset: number, source: string) => {
    // Only a bare number precedes a unit; anything word-like before it makes
    // this part of a name (`--gap-1vh`, `a1vh`).
    const before = offset > 0 ? source[offset - 1] : ''
    if (before !== '' && /[\w-]/.test(before)) return match
    return toPx(Number(value), axis, viewport)
  })
}

export function resolveViewportUnits(html: string, viewport: ReviewViewport): string {
  return html
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_match, open: string, css: string, close: string) => open + resolveCss(css, viewport) + close)
    .replace(/(\sstyle=")([^"]*)(")/gi, (_match, open: string, css: string, close: string) => open + resolveCss(css, viewport) + close)
}
