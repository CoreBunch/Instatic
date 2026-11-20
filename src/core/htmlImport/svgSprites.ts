/**
 * Inline SVG sprite references (`<svg><use href="icons.svg#logo"/></svg>`).
 *
 * `base.svg` stores one self-contained SVG, and the SVG sanitiser forbids
 * `<use>` (DOMPurify leaves it out of the SVG profile: a `<use>` can pull in a
 * whole external document). A sprite icon would therefore publish as an empty
 * `<svg>` and the sprite file would never be imported. Instead each `<use>` is
 * replaced by a copy of the element it points at before the walk runs, so the
 * icon survives as plain shapes:
 *
 *   - a `<symbol>` becomes a nested `<svg>` with the symbol's attributes
 *     (`viewBox`, `preserveAspectRatio`, presentation) and then the `<use>`'s
 *     own geometry and presentation attributes (the box a `<use>` of a symbol
 *     draws into);
 *   - any other element is copied into a `<g>` that carries the `<use>`'s
 *     attributes, its `x` / `y` becoming a translate.
 *
 * References resolve against the page itself (`#id`, the inline-sprite
 * pattern) and, through `loadSvgSprite`, against external sprite files
 * (`icons.svg#id`). Shapes inside a copied symbol may hold `<use>`s of their
 * own, so passes repeat until nothing more resolves (bounded, so a symbol that
 * references itself cannot loop).
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const MAX_PASSES = 4

/** Attributes of `<use>` that name its target rather than style the copy. */
const USE_REFERENCE_ATTRIBUTES = new Set(['href', 'xlink:href'])
/** Attributes of `<use>` that position or size the copy. */
const USE_GEOMETRY_ATTRIBUTES = new Set(['x', 'y', 'width', 'height'])

/**
 * Returns the text of a sprite file, given the `href` part before `#`
 * exactly as authored (the caller resolves it against the page), or `null`
 * when the file is not available.
 */
export type SvgSpriteLoader = (path: string) => string | null

/**
 * Replace every resolvable `<use>` inside an `<svg>` with a copy of its
 * target. Mutates `doc`. Returns the hrefs that could not be resolved, once
 * each, so a caller can tell the author which icons stayed empty.
 */
export function inlineSvgSpriteReferences(doc: Document, loadSvgSprite?: SvgSpriteLoader): string[] {
  const sprites = new Map<string, Document | null>()
  const unresolved = new Set<string>()

  const spriteDocument = (path: string): Document | null => {
    if (sprites.has(path)) return sprites.get(path) ?? null
    const source = loadSvgSprite?.(path) ?? null
    const parsed = source === null ? null : parseSprite(source)
    sprites.set(path, parsed)
    return parsed
  }

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let replaced = 0
    for (const use of Array.from(doc.querySelectorAll('svg use'))) {
      const href = referenceOf(use)
      if (!href) continue
      const hashIndex = href.indexOf('#')
      const path = hashIndex === -1 ? href : href.slice(0, hashIndex)
      const id = hashIndex === -1 ? '' : decodeFragment(href.slice(hashIndex + 1))
      const source = path === '' ? doc : spriteDocument(path)
      const target = id && source ? findById(source, id) : null
      if (!target || target.contains(use)) {
        unresolved.add(href)
        continue
      }
      const copy = copyForUse(doc, use, target)
      if (path !== '') rebaseFragmentReferences(copy, path)
      use.replaceWith(copy)
      unresolved.delete(href)
      replaced += 1
    }
    if (replaced === 0) break
  }

  return [...unresolved]
}

function parseSprite(source: string): Document | null {
  try {
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
    return parsed.documentElement?.localName === 'svg' ? parsed : null
  } catch (_err) {
    // A malformed sprite file resolves nothing; its refs are reported as unresolved.
    return null
  }
}

function referenceOf(use: Element): string {
  return (use.getAttribute('href') ?? use.getAttributeNS(XLINK_NS, 'href') ?? use.getAttribute('xlink:href') ?? '').trim()
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment)
  } catch (_err) {
    // Not percent-encoded after all; use the fragment as written.
    return fragment
  }
}

function findById(source: Document, id: string): Element | null {
  for (const el of Array.from(source.querySelectorAll('[id]'))) {
    if (el.getAttribute('id') === id) return el
  }
  return null
}

function copyForUse(doc: Document, use: Element, target: Element): Element {
  if (target.localName === 'symbol') {
    const box = doc.createElementNS(SVG_NS, 'svg')
    // The symbol's own attributes (its box, and presentation such as `fill`)
    // apply to what it draws; the `<use>`'s attributes then size and style it.
    for (const attr of Array.from(target.attributes)) {
      if (attr.name !== 'id') box.setAttribute(attr.name, attr.value)
    }
    copyUseAttributes(use, box, () => true)
    for (const child of Array.from(target.childNodes)) box.appendChild(doc.importNode(child, true))
    return box
  }

  const group = doc.createElementNS(SVG_NS, 'g')
  copyUseAttributes(use, group, (name) => !USE_GEOMETRY_ATTRIBUTES.has(name))
  const x = Number.parseFloat(use.getAttribute('x') ?? '0') || 0
  const y = Number.parseFloat(use.getAttribute('y') ?? '0') || 0
  if (x !== 0 || y !== 0) {
    const own = group.getAttribute('transform')
    group.setAttribute('transform', `${own ? `${own} ` : ''}translate(${x} ${y})`)
  }
  const copy = doc.importNode(target, true) as Element
  copy.removeAttribute('id')
  group.appendChild(copy)
  return group
}

/**
 * A `#id` inside a copied sprite symbol meant an id in the sprite file, not in
 * the page it is being copied into: point it back at that file so the next
 * pass resolves it there.
 */
function rebaseFragmentReferences(copy: Element, spritePath: string): void {
  for (const nested of Array.from(copy.querySelectorAll('use'))) {
    const href = referenceOf(nested)
    if (!href.startsWith('#')) continue
    nested.removeAttribute('xlink:href')
    nested.setAttribute('href', `${spritePath}${href}`)
  }
}

function copyUseAttributes(use: Element, to: Element, keep: (name: string) => boolean): void {
  for (const attr of Array.from(use.attributes)) {
    if (USE_REFERENCE_ATTRIBUTES.has(attr.name) || !keep(attr.name)) continue
    to.setAttribute(attr.name, attr.value)
  }
}
