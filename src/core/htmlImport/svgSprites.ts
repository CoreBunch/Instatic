/**
 * Inline SVG sprite references (`<svg><use href="icons.svg#logo"/></svg>`).
 *
 * `base.svg` stores one self-contained SVG, and the SVG sanitiser forbids
 * `<use>` (DOMPurify leaves it out of the SVG profile: a `<use>` can pull in a
 * whole external document). A sprite icon would therefore publish as an empty
 * `<svg>` and the sprite file would never be imported. Instead each rendered
 * `<use>` is replaced by a copy of the element it points at before the walk
 * runs, so the icon survives as plain shapes:
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
 * (`icons.svg#id`). Inside a copy:
 *
 *   - a nested `<use>` resolves against the document the copy came from,
 *     recursively, up to `MAX_DEPTH` and never through a reference already on
 *     the chain (a symbol that uses itself);
 *   - gradients, clip paths, masks, markers and filters the copy points at
 *     (`url(#id)`, `href="#id"`) but does not contain are copied in as `<defs>`;
 *   - every id gets a suffix unique to the copy, with the copy's own references
 *     rewritten, so two copies of one symbol never share an id.
 *
 * Copying is bounded by `MAX_COPIED_ELEMENTS` per document: chained symbols
 * multiply (twelve uses of a symbol that uses another twelve times, five
 * deep, is 250 000 elements), and this runs on every paste and agent insert.
 * A `<use>` that would exceed it, or that resolves to nothing, stays in place
 * (the sanitiser then drops it) and its href is reported.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const MAX_DEPTH = 8
const MAX_COPIED_ELEMENTS = 5000

/** Attributes of `<use>` that name its target rather than style the copy. */
const USE_REFERENCE_ATTRIBUTES = new Set(['href', 'xlink:href'])
/** Attributes of `<use>` that position or size the copy. */
const USE_GEOMETRY_ATTRIBUTES = new Set(['x', 'y', 'width', 'height'])
const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g

/**
 * Returns the text of a sprite file, given the `href` part before `#`
 * exactly as authored (the caller resolves it against the page), or `null`
 * when the file is not available.
 */
export type SvgSpriteLoader = (path: string) => string | null

interface InlineState {
  doc: Document
  loadSvgSprite: SvgSpriteLoader | undefined
  sprites: Map<string, Document | null>
  /** Elements still allowed to be copied into the document. */
  budget: number
  /** Suffix counter that keeps each copy's ids unique. */
  copies: number
  unresolved: Set<string>
}

/**
 * Replace every rendered `<use>` inside an `<svg>` with a copy of its target.
 * Mutates `doc`. Returns, once each, the hrefs of every `<use>` that could not
 * be replaced, so a caller can tell the author which icons stayed empty.
 */
export function inlineSvgSpriteReferences(doc: Document, loadSvgSprite?: SvgSpriteLoader): string[] {
  const state: InlineState = {
    doc,
    loadSvgSprite,
    sprites: new Map(),
    budget: MAX_COPIED_ELEMENTS,
    copies: 0,
    unresolved: new Set(),
  }
  // A `<use>` inside `<symbol>` or `<defs>` is part of a template, not drawn
  // where it stands; it is expanded when the template is copied.
  const rendered = Array.from(doc.querySelectorAll('svg use')).filter((use) => !use.closest('symbol, defs'))
  for (const use of rendered) expandUse(use, '', [], state)
  return [...state.unresolved]
}

/**
 * Replace one `<use>` with a copy of its target. `spritePath` is the document
 * the `<use>` itself lives in (`''` for the page), which is what a bare `#id`
 * refers to. `chain` holds the references being expanded around it.
 */
function expandUse(use: Element, spritePath: string, chain: readonly string[], state: InlineState): void {
  const href = referenceOf(use)
  if (!href) return
  const hashIndex = href.indexOf('#')
  const path = hashIndex === -1 ? href : href.slice(0, hashIndex) || spritePath
  const id = hashIndex === -1 ? '' : decodeFragment(href.slice(hashIndex + 1))
  const key = `${path}#${id}`
  const source = path === '' ? state.doc : spriteDocument(path, state)
  const target = id && source ? findById(source, id) : null
  if (!target || chain.includes(key) || chain.length >= MAX_DEPTH) {
    state.unresolved.add(href)
    return
  }

  const copy = copyForUse(state.doc, use, target)
  if (!spend(copy, state) || !copyReferencedDefinitions(copy, source!, state)) {
    state.unresolved.add(href)
    return
  }
  makeIdsUnique(copy, state)
  for (const nested of Array.from(copy.querySelectorAll('use'))) {
    expandUse(nested, path, [...chain, key], state)
  }
  use.replaceWith(copy)
}

function spriteDocument(path: string, state: InlineState): Document | null {
  if (state.sprites.has(path)) return state.sprites.get(path) ?? null
  const source = state.loadSvgSprite?.(path) ?? null
  const parsed = source === null ? null : parseSprite(source)
  state.sprites.set(path, parsed)
  return parsed
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

/** Take the copy's element count out of the budget, or refuse when it does not fit. */
function spend(subtree: Element, state: InlineState): boolean {
  const size = 1 + subtree.querySelectorAll('*').length
  if (size > state.budget) return false
  state.budget -= size
  return true
}

function referenceOf(el: Element): string {
  return (el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href') ?? el.getAttribute('xlink:href') ?? '').trim()
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment)
  } catch (_err) {
    // Not percent-encoded after all; use the fragment as written.
    return fragment
  }
}

function findById(source: Document | Element, id: string): Element | null {
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

function copyUseAttributes(use: Element, to: Element, keep: (name: string) => boolean): void {
  for (const attr of Array.from(use.attributes)) {
    if (USE_REFERENCE_ATTRIBUTES.has(attr.name) || !keep(attr.name)) continue
    to.setAttribute(attr.name, attr.value)
  }
}

/**
 * Ids the copy points at through paint, clip, mask, marker and filter
 * references (`url(#id)`) or a non-`<use>` `href="#id"` (gradient templates,
 * `<textPath>`). `<use>` hrefs are left to `expandUse`.
 */
function referencedIds(root: Element): Set<string> {
  const ids = new Set<string>()
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      for (const match of attr.value.matchAll(URL_REFERENCE)) ids.add(decodeFragment(match[2]!))
    }
    if (el.localName !== 'use') {
      const href = referenceOf(el)
      if (href.startsWith('#')) ids.add(decodeFragment(href.slice(1)))
    }
  }
  return ids
}

/**
 * Copy into `copy` (as `<defs>`) every definition it references that lives
 * elsewhere in `source`: a symbol's gradient usually sits in the sprite's
 * top-level `<defs>`, which a copy of the symbol alone would leave behind.
 * Returns false when the budget runs out.
 */
function copyReferencedDefinitions(copy: Element, source: Document, state: InlineState): boolean {
  let defs: Element | null = null
  const seen = new Set<string>()
  for (;;) {
    const missing = [...referencedIds(copy)].filter((id) => !seen.has(id) && !findById(copy, id))
    if (missing.length === 0) return true
    for (const id of missing) {
      seen.add(id)
      const definition = findById(source, id)
      if (!definition) continue
      const clone = state.doc.importNode(definition, true) as Element
      if (!spend(clone, state)) return false
      defs ??= copy.insertBefore(state.doc.createElementNS(SVG_NS, 'defs'), copy.firstChild)
      defs.appendChild(clone)
    }
  }
}

/**
 * Give every id in the copy a suffix unique to it and point the copy's own
 * references at the new names. `<use>` hrefs keep their original names: they
 * are resolved against the source document, not the copy.
 */
function makeIdsUnique(copy: Element, state: InlineState): void {
  const owners = Array.from(copy.querySelectorAll('[id]'))
  if (owners.length === 0) return
  state.copies += 1
  const renamed = new Map<string, string>()
  for (const owner of owners) {
    const id = owner.getAttribute('id')!
    const next = `${id}-${state.copies}`
    renamed.set(id, next)
    owner.setAttribute('id', next)
  }
  for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (el.localName === 'use' && USE_REFERENCE_ATTRIBUTES.has(attr.name)) continue
      let value = attr.value.replace(URL_REFERENCE, (whole, quote: string, id: string) => {
        const next = renamed.get(decodeFragment(id))
        return next ? `url(${quote}#${next}${quote})` : whole
      })
      if (USE_REFERENCE_ATTRIBUTES.has(attr.name) && value.startsWith('#')) {
        value = `#${renamed.get(decodeFragment(value.slice(1))) ?? value.slice(1)}`
      }
      if (value !== attr.value) el.setAttribute(attr.name, value)
    }
  }
}
