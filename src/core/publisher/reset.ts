/**
 * Publisher reset — minimal modern CSS reset shipped with every published page.
 *
 * Why this exists
 * ───────────────
 * Without a reset the published HTML inherits UA defaults: `box-sizing: content-box`,
 * `<body>` `margin: 8px`, heading/paragraph margins, list `padding-left`, Times-style
 * default font, etc. The design canvas (rendered inside the editor DOM) inherits the
 * editor's `globals.css` reset (`* { margin:0; padding:0; box-sizing:border-box }`,
 * Inter font, etc.). The two render surfaces therefore disagree on basics like font,
 * spacing, and box model — exactly the drift users notice when comparing the canvas
 * to the iframe preview / published front end.
 *
 * The fix is a single canonical reset string that is:
 *
 *  1. injected unscoped into the `<style>` block by `publishPage()`
 *     (so the iframe preview AND the published front end share one baseline), and
 *  2. injected scoped to `[data-breakpoint-id]` in the canvas (via canvasClassCss)
 *     so the canvas viewport matches the published page exactly. Editor chrome
 *     keeps its own `globals.css` reset because the scoping selector only catches
 *     the breakpoint frames.
 *
 * Specificity / cascade
 * ─────────────────────
 * Every selector is wrapped in `:where(...)` so the reset has zero specificity.
 * That means any user class, framework utility, or module CSS rule trivially
 * overrides reset declarations — no `!important`, no specificity wars.
 *
 * Stability
 * ─────────
 * This is the canonical baseline. If new rules are added they must be added here
 * (so canvas + published stay in sync). Don't fork a parallel reset somewhere else.
 */

/**
 * Minimal modern reset, ordered roughly Andy-Bell-style + a few extras to match
 * the editor's existing canvas reset behaviour (zero padding on every element,
 * list bullets stripped). Form controls inherit typography so site-level fonts
 * propagate into `<button>` / `<input>` without per-module work.
 */
export const PUBLISHER_RESET_CSS = [
  // Box model — apply to every element including pseudos
  ':where(*, *::before, *::after) { box-sizing: border-box; }',

  // Strip default margin and padding on every element. Matches the editor's
  // canvas reset so the design view and the published page agree on spacing.
  ':where(*) { margin: 0; padding: 0; }',

  // Keep the document's natural height. Constraining both roots to 100% makes
  // an authored `overflow-x: hidden` turn <body> into a viewport-height scroll
  // container, so window-level scroll listeners never observe page scrolling.
  //
  // font-family is pinned to system-ui so the published page picks the OS
  // native font (matches what most modern stacks ship). Users who want a
  // custom default can set it on `body` via a class or framework typography
  // settings.
  ':where(body) {' +
    ' line-height: 1.5;' +
    ' font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;' +
    ' -webkit-font-smoothing: antialiased;' +
    ' -moz-osx-font-smoothing: grayscale;' +
    ' }',

  // Media defaults — block-level + responsive by default, so images don't
  // overflow their containers and don't sit on a baseline by accident.
  // `height: auto` is critical: the publisher emits `width` and `height`
  // HTML attributes (intrinsic dimensions for CLS prevention), which the
  // UA stylesheet maps to BOTH `width: Xpx` and `height: Ypx` as
  // presentational hints. Without `height: auto`, `max-width: 100%`
  // clamps the width to the container but leaves `height` pinned at the
  // intrinsic pixel value — i.e. a 5504×3072 image renders 300px wide
  // and 3072px tall (stretched). `height: auto` lets the established
  // `aspect-ratio` (from the attributes) scale the height with the
  // width. This is the canonical fix used by every modern reset
  // (Andy Bell, Tailwind preflight, normalize.css 9+).
  ':where(img, picture, video, canvas, svg) { display: block; max-width: 100%; height: auto; }',

  // Form controls inherit typography from their parent. Without this, browsers
  // use their own font stack for `<button>` / `<input>` which collides with the
  // site font.
  ':where(input, button, textarea, select) { font: inherit; color: inherit; }',
  ':where(button) { background: none; border: 0; cursor: pointer; }',

  // Long-word safety on text-bearing elements.
  ':where(p, h1, h2, h3, h4, h5, h6) { overflow-wrap: break-word; }',

  // Lists: no bullets by default. Most site lists are styled menus / nav, not
  // editorial bulleted lists. Users who want bullets re-enable via a class.
  ':where(ol, ul, menu) { list-style: none; }',

  // Links inherit colour and decoration so they only differ from surrounding
  // text when explicitly styled.
  ':where(a) { color: inherit; text-decoration: inherit; }',

  // Tables collapse borders by default — the standard expectation in modern CSS.
  ':where(table) { border-collapse: collapse; }',
].join('\n')

// `scopedPublisherResetCss` is gone. It used to wrap every reset rule in a
// `[data-breakpoint-id]` prefix so the canvas could share a document with
// the editor chrome without the reset bleeding into toolbars/panels. The
// canvas now renders each breakpoint frame inside its own iframe, so the
// reset can simply be the unscoped `PUBLISHER_RESET_CSS` — same bytes the
// publisher ships, same cascade. See `docs/features/canvas-iframe-per-frame.md`.
