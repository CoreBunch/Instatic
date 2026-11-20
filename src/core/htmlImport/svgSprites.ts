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
 *     attributes, its `x` / `y` becoming a translate. Inside a `<clipPath>` or
 *     `<mask>`, where a `<g>` is not a valid child, the shape itself is copied
 *     with the offset folded into its `transform`.
 *
 * References resolve against the page itself (`#id`, the inline-sprite
 * pattern) and, through `loadSvgSprite`, against external sprite files
 * (`icons.svg#id`); a sprite file named inside another sprite resolves
 * relative to that sprite. Inside a copy:
 *
 *   - a nested `<use>` resolves against the document the copy came from,
 *     recursively, up to `MAX_DEPTH` and never through a reference already on
 *     the chain (a symbol that uses itself);
 *   - paint servers, clip paths, masks, markers and filters the copy points at
 *     (`url(#id)`, a gradient's `href`, a `<textPath>`'s path) but does not
 *     contain are copied in as `<defs>`;
 *   - every id gets a random suffix no id on the page already has, and the
 *     copy's own references (`url()`, `href`, SMIL `begin` / `end`) follow;
 *   - a `<style>` is kept in the first copy of its symbol only, so its CSS
 *     reaches the page once. A same-page symbol's `<style>` already does.
 *
 * Work is bounded, because this runs on every paste and agent insert:
 * `MAX_COPIED_ELEMENTS` per document (checked against the target's size before
 * anything is cloned; chained symbols multiply) and `MAX_USES` `<use>`s
 * processed. Every id lookup goes through one index per source document. A
 * `<use>` that is unresolved, cyclic, too deep or past either limit stays in
 * place (the sanitiser then drops it) and its href is reported.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const MAX_DEPTH = 8
const MAX_COPIED_ELEMENTS = 5000
const MAX_USES = 2000

/** Attributes of `<use>` that name its target rather than style the copy. */
const USE_REFERENCE_ATTRIBUTES = new Set(['href', 'xlink:href'])
/** Attributes of `<use>` that position or size the copy. */
const USE_GEOMETRY_ATTRIBUTES = new Set(['x', 'y', 'width', 'height'])
/** Parents whose content must be shapes, so a copy there cannot be a `<g>`. */
const SHAPE_ONLY_PARENTS = new Set(['clipPath', 'mask'])
/** What a `url(#id)` may point at and be copied in as a definition. */
const DEFINITION_KINDS = new Set([
  'linearGradient', 'radialGradient', 'pattern', 'clipPath', 'mask', 'marker', 'filter',
])
/** Elements whose `href="#id"` names a definition: gradient / pattern / filter templates. */
const TEMPLATE_HREF_KINDS = new Set(['linearGradient', 'radialGradient', 'pattern', 'filter'])
const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g
const SMIL_TIMING_ATTRIBUTES = new Set(['begin', 'end'])

/**
 * Returns the text of a sprite file, given its path relative to the page
 * (`href` before `#`, joined onto the sprite that named it when nested), or
 * `null` when the file is not available.
 */
export type SvgSpriteLoader = (path: string) => string | null

interface InlineState {
  doc: Document
  loadSvgSprite: SvgSpriteLoader | undefined
  sprites: Map<string, Document | null>
  /** One id → element index per source document, built on first lookup. */
  indexes: Map<Document, Map<string, Element>>
  sizes: Map<Element, number>
  /** Elements still allowed to be copied into the document. */
  budget: number
  /** `<use>`s still allowed to be processed. */
  uses: number
  /** Every id on the page or handed to a copy, so new suffixes never collide. */
  takenIds: Set<string>
  /** Symbols (path#id) whose `<style>` already reached the page. */
  styledSymbols: Set<string>
  unresolved: Set<string>
}

/**
 * Replace every rendered `<use>` inside an `<svg>` with a copy of its target.
 * Mutates `doc`. Returns, once each, the hrefs of every `<use>` that could not
 * be replaced, so a caller can tell the author which icons stayed empty.
 */
export function inlineSvgSpriteReferences(doc: Document, loadSvgSprite?: SvgSpriteLoader): string[] {
  // A `<use>` inside `<symbol>` or `<defs>` is part of a template, not drawn
  // where it stands; it is expanded when the template is copied. One inside a
  // `<clipPath>` or `<mask>` is drawn where that is applied, so it counts.
  const rendered = Array.from(doc.querySelectorAll('svg use')).filter((use) =>
    !use.closest('symbol') && (!use.closest('defs') || use.closest('clipPath, mask') !== null))
  if (rendered.length === 0) return []
  const state: InlineState = {
    doc,
    loadSvgSprite,
    sprites: new Map(),
    indexes: new Map(),
    sizes: new Map(),
    budget: MAX_COPIED_ELEMENTS,
    uses: MAX_USES,
    takenIds: new Set(Array.from(doc.querySelectorAll('[id]'), (el) => el.getAttribute('id')!)),
    styledSymbols: new Set(),
    unresolved: new Set(),
  }
  for (const use of rendered) expandUse(use, '', [], state)
  return [...state.unresolved]
}

/**
 * Replace one `<use>` with a copy of its target. `spritePath` is the document
 * the `<use>` itself lives in (`''` for the page), which is what its href is
 * relative to. `chain` holds the references being expanded around it.
 */
function expandUse(use: Element, spritePath: string, chain: readonly string[], state: InlineState): void {
  const href = referenceOf(use)
  if (!href) return
  if (state.uses <= 0 || state.budget <= 0) {
    state.unresolved.add(href)
    return
  }
  state.uses -= 1

  const hashIndex = href.indexOf('#')
  const authoredPath = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const path = authoredPath === '' ? spritePath : resolveSpritePath(authoredPath, spritePath)
  const id = hashIndex === -1 ? '' : decodeFragment(href.slice(hashIndex + 1))
  const key = `${path}#${id}`
  const source = path === '' ? state.doc : spriteDocument(path, state)
  const target = id && source ? lookup(source, id, state) : null
  const size = target ? sizeOf(target, state) + 1 : 0
  if (!target || chain.includes(key) || chain.length >= MAX_DEPTH || size > state.budget) {
    state.unresolved.add(href)
    return
  }

  const shapeOnly = SHAPE_ONLY_PARENTS.has(use.parentElement?.localName ?? '')
  if (shapeOnly && target.localName === 'symbol') {
    state.unresolved.add(href)
    return
  }
  state.budget -= size
  const copy = shapeOnly ? copyShapeForUse(state.doc, use, target) : copyForUse(state.doc, use, target)
  keepStyleOnce(copy, key, path === '', state)
  if (!copyReferencedDefinitions(copy, source!, state)) {
    state.unresolved.add(href)
    return
  }
  makeIdsUnique(copy, state)
  for (const nested of Array.from(copy.querySelectorAll('use'))) {
    expandUse(nested, path, [...chain, key], state)
  }
  use.replaceWith(copy)
}

/**
 * A sprite named inside another sprite is relative to that sprite, so join it
 * onto the containing file's folder. The result is the page-relative path the
 * loader takes (and the cycle check compares), with `.` and `..` folded.
 */
function resolveSpritePath(path: string, spritePath: string): string {
  if (spritePath === '' || /^([a-z][a-z0-9+.-]*:|\/)/i.test(path)) return path
  const folder = spritePath.slice(0, spritePath.lastIndexOf('/') + 1)
  const parts: string[] = []
  for (const part of `${folder}${path}`.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
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

/** The element with this id in a source document; the first one wins, as in a browser. */
function lookup(source: Document, id: string, state: InlineState): Element | null {
  let index = state.indexes.get(source)
  if (!index) {
    index = new Map()
    for (const el of Array.from(source.querySelectorAll('[id]'))) {
      const elId = el.getAttribute('id')!
      if (!index.has(elId)) index.set(elId, el)
    }
    state.indexes.set(source, index)
  }
  return index.get(id) ?? null
}

/** Elements in a subtree, counted once per source element. */
function sizeOf(el: Element, state: InlineState): number {
  let size = state.sizes.get(el)
  if (size === undefined) {
    size = 1 + el.querySelectorAll('*').length
    state.sizes.set(el, size)
  }
  return size
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
  appendTransform(group, offsetOf(use))
  const copy = doc.importNode(target, true) as Element
  copy.removeAttribute('id')
  group.appendChild(copy)
  return group
}

/**
 * A copy for a `<use>` inside `<clipPath>` / `<mask>`: the shape itself, with
 * the `<use>`'s transform and offset in front of its own and the `<use>`'s
 * presentation attributes where the shape sets none.
 */
function copyShapeForUse(doc: Document, use: Element, target: Element): Element {
  const copy = doc.importNode(target, true) as Element
  copy.removeAttribute('id')
  const own = copy.getAttribute('transform')
  copy.removeAttribute('transform')
  appendTransform(copy, use.getAttribute('transform'))
  appendTransform(copy, offsetOf(use))
  appendTransform(copy, own)
  for (const attr of Array.from(use.attributes)) {
    if (USE_REFERENCE_ATTRIBUTES.has(attr.name) || USE_GEOMETRY_ATTRIBUTES.has(attr.name)) continue
    if (attr.name === 'transform' || copy.hasAttribute(attr.name)) continue
    copy.setAttribute(attr.name, attr.value)
  }
  return copy
}

function offsetOf(use: Element): string | null {
  const x = Number.parseFloat(use.getAttribute('x') ?? '0') || 0
  const y = Number.parseFloat(use.getAttribute('y') ?? '0') || 0
  return x !== 0 || y !== 0 ? `translate(${x} ${y})` : null
}

function appendTransform(el: Element, transform: string | null): void {
  if (!transform) return
  const own = el.getAttribute('transform')
  el.setAttribute('transform', own ? `${own} ${transform}` : transform)
}

function copyUseAttributes(use: Element, to: Element, keep: (name: string) => boolean): void {
  for (const attr of Array.from(use.attributes)) {
    if (USE_REFERENCE_ATTRIBUTES.has(attr.name) || !keep(attr.name)) continue
    to.setAttribute(attr.name, attr.value)
  }
}

/**
 * A `<style>` inside a symbol is page CSS once the copy lands. Keep it in the
 * first copy of an external symbol and drop it from every other copy; a
 * same-page symbol's `<style>` is on the page already.
 */
function keepStyleOnce(copy: Element, key: string, samePage: boolean, state: InlineState): void {
  const styles = Array.from(copy.querySelectorAll('style'))
  if (styles.length === 0) return
  if (!samePage && !state.styledSymbols.has(key)) {
    state.styledSymbols.add(key)
    return
  }
  for (const style of styles) style.remove()
}

/**
 * Definition ids the copy points at: `url(#id)` in any attribute (fill,
 * stroke, clip-path, mask, marker, filter, style), a gradient / pattern /
 * filter template `href`, and a `<textPath>`'s path. Each maps to the element
 * kinds it may name, so an `<a href="#pricing">` never pulls page markup in.
 */
function referencedDefinitions(root: Element): Map<string, 'definition' | 'path'> {
  const ids = new Map<string, 'definition' | 'path'>()
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      for (const match of attr.value.matchAll(URL_REFERENCE)) ids.set(decodeFragment(match[2]!), 'definition')
    }
    const href = referenceOf(el)
    if (!href.startsWith('#')) continue
    if (TEMPLATE_HREF_KINDS.has(el.localName)) ids.set(decodeFragment(href.slice(1)), 'definition')
    else if (el.localName === 'textPath') ids.set(decodeFragment(href.slice(1)), 'path')
  }
  return ids
}

/**
 * Copy into `copy` (as `<defs>`) every definition it references that lives
 * elsewhere in `source`: a symbol's gradient usually sits in the sprite's
 * top-level `<defs>`, which a copy of the symbol alone would leave behind.
 * Sizes are checked before cloning; returns false when the budget runs out.
 */
function copyReferencedDefinitions(copy: Element, source: Document, state: InlineState): boolean {
  let defs: Element | null = null
  const seen = new Set<string>()
  const local = new Set(Array.from(copy.querySelectorAll('[id]'), (el) => el.getAttribute('id')!))
  for (;;) {
    const missing = [...referencedDefinitions(copy)].filter(([id]) => !seen.has(id) && !local.has(id))
    if (missing.length === 0) return true
    for (const [id, kind] of missing) {
      seen.add(id)
      const definition = lookup(source, id, state)
      if (!definition) continue
      const allowed = kind === 'path' ? definition.localName === 'path' : DEFINITION_KINDS.has(definition.localName)
      if (!allowed) continue
      const size = sizeOf(definition, state)
      if (size > state.budget) return false
      state.budget -= size
      defs ??= copy.insertBefore(state.doc.createElementNS(SVG_NS, 'defs'), copy.firstChild)
      defs.appendChild(state.doc.importNode(definition, true))
      local.add(id)
    }
  }
}

/** A short random suffix; ids only need to differ from every other id on the page. */
function randomSuffix(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('')
}

/**
 * Give every id in the copy a random suffix no id on the page already has,
 * and point the copy's own references (`url()`, non-`<use>` `href`, SMIL
 * `begin` / `end` syncbases) at the new names. `<use>` hrefs keep their
 * original names: they are resolved against the source document.
 */
function makeIdsUnique(copy: Element, state: InlineState): void {
  const owners = Array.from(copy.querySelectorAll('[id]'))
  if (owners.length === 0) return
  let suffix = randomSuffix()
  while (owners.some((owner) => state.takenIds.has(`${owner.getAttribute('id')}-${suffix}`))) suffix = randomSuffix()
  const renamed = new Map<string, string>()
  for (const owner of owners) {
    const id = owner.getAttribute('id')!
    const next = `${id}-${suffix}`
    renamed.set(id, next)
    state.takenIds.add(next)
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
      if (SMIL_TIMING_ATTRIBUTES.has(attr.name)) value = renameSyncbases(value, renamed)
      if (value !== attr.value) el.setAttribute(attr.name, value)
    }
  }
}

/** `a1.end; dot.click+1s` → each `<id>.` that was renamed, renamed. */
function renameSyncbases(value: string, renamed: ReadonlyMap<string, string>): string {
  return value
    .split(';')
    .map((part) => part.replace(/^(\s*)([^.\s;]+)\./, (whole, lead: string, id: string) => {
      const next = renamed.get(id)
      return next ? `${lead}${next}.` : whole
    }))
    .join(';')
}
