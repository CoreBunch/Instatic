/**
 * HTML element-tag resolution for modules that let the author pick which
 * semantic element they render as (`base.container`, `base.loop`,
 * `base.outlet`).
 *
 * Two pieces:
 *   - the canonical list of built-in tag choices (semantic layout + list tags)
 *   - a "custom" escape hatch so authors can type any valid HTML element name
 *     when the built-in list isn't enough (e.g. `aside`, `figure`, `dl`, …).
 *
 * Resolution always returns a safe lowercase HTML element name (or 'div' on
 * unknown / invalid input). The publisher render path (`renderLoop`, module
 * `render()` functions) and the editor preview components share the same
 * resolver so the canvas matches the published HTML exactly. The
 * `PropertyControl` builders that surface these choices in the Properties
 * panel live module-side in `@modules/base/utils/htmlTag`.
 *
 * The custom name pattern matches the HTML5 element-name spec but is
 * intentionally narrowed to a safe subset: starts with an ASCII letter,
 * followed by letters, digits, or hyphens — that covers every standard tag
 * plus custom elements (`x-foo`, `my-widget`) without permitting characters
 * that could break out of the attribute / tag context.
 */

/** The built-in tag choices offered by the standard tag `select` control. */
export const BUILTIN_HTML_TAGS = [
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'ul',
  'ol',
] as const

/** Sentinel select-value indicating "use the user-typed `customTag` instead". */
export const CUSTOM_HTML_TAG_VALUE = 'custom'

/**
 * The complete set of HTML void elements (lowercase) — they have no closing
 * tag and no children. Shared by:
 *   - the publisher render path (`base.container`), where emitting
 *     `<br></br>` is a bug: the parser reinterprets the end tag as a second
 *     start tag, doubling the element.
 *   - the editor preview (`ContainerEditor`), where React throws if a void
 *     element is given children (or the empty-container placeholder).
 *
 * One list so canvas and published HTML can never disagree about which tags
 * are self-closing.
 */
export const VOID_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const BUILTIN_HTML_TAG_SET: ReadonlySet<string> = new Set(BUILTIN_HTML_TAGS)

/** HTML element names: ASCII letter, then letters/digits/hyphens. 1–32 chars. */
const CUSTOM_TAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/i

/**
 * Elements that must never be produced from the free-form custom-tag escape
 * hatch — they execute script, load external/plugin resources, or hijack the
 * document's base URL, and would run in the published page AND the admin editor
 * canvas (which renders these trusted modules directly, same-origin as
 * `/admin`). `base.video` emits its own trusted `<iframe>` via its module
 * `htmlTag`, not this resolver, so blocking `iframe` here does not affect video
 * embeds — it only stops a container/loop/outlet author typing a dangerous tag.
 */
const FORBIDDEN_CUSTOM_HTML_TAGS: ReadonlySet<string> = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'base', 'link', 'meta', 'style',
])

/**
 * Resolve the tag a module should render given its `tag` + `customTag` props.
 *
 * Returns a safe lowercase tag name. Falls back to 'div' when:
 *   - `tag` is missing / not a string
 *   - `tag` is 'custom' but `customTag` is missing or fails the safe-name regex
 *   - `tag` is some non-built-in string we don't recognise
 */
export function resolveHtmlTag(tag: unknown, customTag: unknown): string {
  if (typeof tag !== 'string') return 'div'
  if (tag === CUSTOM_HTML_TAG_VALUE) {
    if (typeof customTag !== 'string') return 'div'
    const trimmed = customTag.trim()
    if (!CUSTOM_TAG_PATTERN.test(trimmed)) return 'div'
    const lower = trimmed.toLowerCase()
    if (FORBIDDEN_CUSTOM_HTML_TAGS.has(lower)) return 'div'
    return lower
  }
  if (BUILTIN_HTML_TAG_SET.has(tag)) return tag.toLowerCase()
  return 'div'
}
