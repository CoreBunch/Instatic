/**
 * Inline SVG sprite references (`<svg><use href="icons.svg#logo"/></svg>`).
 *
 * `base.svg` stores one self-contained SVG, and the SVG sanitiser forbids
 * `<use>` (DOMPurify leaves it out of the SVG profile: a `<use>` can pull in a
 * whole external document). A sprite icon would therefore publish as an empty
 * `<svg>`. Instead each rendered `<use>` is replaced by a copy of what it
 * points at before the walk runs, so the icon survives as plain shapes:
 *
 *   - a `<symbol>` becomes a nested `<svg>` with the symbol's attributes
 *     (`viewBox`, presentation) and then the `<use>`'s own (the box a `<use>`
 *     of a symbol draws into);
 *   - any other element is copied into a `<g>` that carries the `<use>`'s
 *     attributes, its `x` / `y` becoming a translate. Inside a `<clipPath>`,
 *     whose children must be shapes, the shape itself is copied with the
 *     offset folded into its `transform`.
 *
 * The design rests on three rules that keep it bounded on any input (it runs
 * on every paste and agent insert, not only Site Import):
 *
 *   1. Sources are immutable. `#id` resolves against the original page
 *      before any instance is replaced, `file.svg#id` against the sprite file as
 *      loaded. An expansion never feeds a later one.
 *   2. All work is charged to one counter, `MAX_WORK` per call: every node
 *      created (counted while cloning, so a huge target is never cloned past
 *      the limit), every attribute scanned, every `<use>` and definition
 *      lookup. When it runs out, expansion stops and every remaining `<use>`
 *      is reported unresolved.
 *   3. Each node is scanned once, while it is cloned: the scan collects the
 *      copy's nested `<use>`s, the definitions it references and its ids.
 *      Definitions are copied through a worklist that only ever looks at the
 *      definitions it just appended.
 *
 * Inside a copy, a nested `<use>` resolves against the document the copy came
 * from (up to `MAX_DEPTH` deep, never through a reference already on the
 * chain); referenced paint servers, clip paths, masks, markers and filters, a
 * `<textPath>` / `<mpath>` path, and an `<feImage>` or animation target are
 * copied in as `<defs>`; every id gets a random suffix no page id has, and the
 * copy's references (`url()`, `href`, SMIL `begin` / `end`, ARIA id lists,
 * `<style>` text) follow. Shared styles reach the page once, and styles using copy-local ids follow each copy.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const ELEMENT_NODE = 1
const TEXT_NODE = 3
const MAX_DEPTH = 8
const MAX_WORK = 20000

/** Attributes of `<use>` that name its target rather than style the copy. */
const USE_REFERENCE_ATTRIBUTES = new Set(['href', 'xlink:href'])
/** Attributes of `<use>` that position or size the copy. */
const USE_GEOMETRY_ATTRIBUTES = new Set(['x', 'y', 'width', 'height'])
const SHAPES = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']

/** What each kind of reference may name, so an `<a href="#pricing">` never pulls page markup in. */
const REFERENCE_KINDS = {
  definition: new Set(['linearGradient', 'radialGradient', 'pattern', 'clipPath', 'mask', 'marker', 'filter']),
  shape: new Set(SHAPES),
  graphic: new Set([...SHAPES, 'g', 'text', 'image']),
} as const
type ReferenceKind = keyof typeof REFERENCE_KINDS

/** The kind of element a non-`<use>` `href="#id"` names, by the element carrying it. */
const HREF_KIND: Record<string, ReferenceKind> = {
  linearGradient: 'definition',
  radialGradient: 'definition',
  pattern: 'definition',
  filter: 'definition',
  textPath: 'shape',
  mpath: 'shape',
  feImage: 'graphic',
  animate: 'graphic',
  animateMotion: 'graphic',
  animateTransform: 'graphic',
  set: 'graphic',
}

const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g
const ID_LIST_ATTRIBUTES = new Set(['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'])
const SMIL_TIMING_ATTRIBUTES = new Set(['begin', 'end'])

/**
 * Returns the text of a sprite file, given its canonical path relative to the
 * page (query and fragment stripped, `.` / `..` folded, a leading `/` kept for
 * root-relative), or `null` when the file is not available.
 */
export type SvgSpriteLoader = (path: string) => string | null

interface InlineState {
  doc: Document
  loadSvgSprite: SvgSpriteLoader | undefined
  /** Parsed sprite files by canonical path. */
  sprites: Map<string, Element | null>
  work: number
  /** IDs reserved by copies that are waiting to be inserted into the page. */
  takenIds: Set<string>
  /** Symbols (path#id) whose `<style>` already reached the page. */
  styledSymbols: Set<string>
  unresolved: Set<string>
}

/** Everything one clone produced, gathered while cloning (rule 3). */
interface Collected {
  elements: Element[]
  uses: Element[]
  styles: Element[]
  idOwners: Element[]
  references: Array<[string, ReferenceKind]>
}

/**
 * Replace every rendered `<use>` inside an `<svg>` with a copy of its target.
 * Mutates `doc`. Returns, once each, the hrefs of every `<use>` that could not
 * be replaced, so a caller can tell the author which icons stayed empty.
 */
export function inlineSvgSpriteReferences(doc: Document, loadSvgSprite?: SvgSpriteLoader): string[] {
  // A `<use>` inside `<symbol>` or a plain `<defs>` template is not drawn where
  // it stands; it is expanded when the template is copied. One inside a
  // `<clipPath>` or `<mask>` is drawn wherever that is applied, so it counts.
  const rendered = Array.from(doc.querySelectorAll('svg use')).filter((use) =>
    !use.closest('symbol') && (!use.closest('defs') || use.closest('clipPath, mask') !== null))
  if (rendered.length === 0) return []
  const state: InlineState = {
    doc,
    loadSvgSprite,
    sprites: new Map(),
    work: MAX_WORK,
    takenIds: new Set(),
    styledSymbols: new Set(),
    unresolved: new Set(),
  }
  // Resolve against the original DOM, then apply the replacements. An early
  // instance can never modify a later instance's source, and a single icon
  // does not require cloning the page around it.
  const replacements: Array<[Element, Element]> = []
  for (const use of rendered) {
    const copy = expandUse(use, '', [], state)
    if (copy) replacements.push([use, copy])
    else state.unresolved.add(referenceOf(use))
  }
  for (const [use, copy] of replacements) use.replaceWith(copy)
  state.unresolved.delete('')
  return [...state.unresolved]
}

/**
 * Build the copy that replaces one `<use>`, or `null` when it cannot be
 * built. `spritePath` is the canonical path of the document the `<use>` came
 * from (`''` for the page); `chain` holds the references expanded around it.
 */
function expandUse(use: Element, spritePath: string, chain: readonly string[], state: InlineState): Element | null {
  if (!charge(state, 1)) return null
  const href = referenceOf(use)
  const hashIndex = href.indexOf('#')
  if (hashIndex === -1) return null
  const path = canonicalSpritePath(href.slice(0, hashIndex), spritePath)
  const id = decodeFragment(href.slice(hashIndex + 1))
  const key = `${path}#${id}`
  if (!id || chain.includes(key) || chain.length >= MAX_DEPTH) return null
  const source = path === '' ? state.doc.documentElement : spriteRoot(path, state)
  const target = source?.ownerDocument.getElementById(id)
  if (!target || target.namespaceURI !== SVG_NS) return null

  const shapeOnly = use.parentElement?.localName === 'clipPath'
  if (shapeOnly && !REFERENCE_KINDS.shape.has(target.localName) && target.localName !== 'text') return null

  const out: Collected = { elements: [], uses: [], styles: [], idOwners: [], references: [] }
  const copy = shapeOnly
    ? copyShapeForUse(use, target, out, state)
    : copyForUse(use, target, out, state)
  if (!copy || !copyReferencedDefinitions(copy, source!, out, state)) return null

  const originalStyles = out.styles.map((style) => style.textContent)
  makeIdsUnique(out, state)
  keepStyleOnce(out, originalStyles, key, path === '', state)
  // Instance attributes belong to the document containing the use. Apply
  // them after renaming the symbol's internal gradient and accessibility ids.
  if (target.localName === 'symbol') copyUseAttributes(use, copy, () => true)
  for (const nested of out.uses) {
    const nestedCopy = expandUse(nested, path, [...chain, key], state)
    if (nestedCopy) nested.replaceWith(nestedCopy)
    else state.unresolved.add(referenceOf(nested))
  }
  return copy
}

function charge(state: InlineState, amount: number): boolean {
  state.work -= amount
  return state.work >= 0
}

/**
 * The canonical page-relative path of a sprite file: query and fragment
 * dropped, `.` and `..` folded, a leading `/` kept for root-relative paths.
 * A path named inside another sprite is relative to that sprite's folder.
 * `''` (a bare `#id`) is the document the reference sits in.
 */
function canonicalSpritePath(rawPath: string, spritePath: string): string {
  const path = rawPath.split(/[?#]/, 1)[0]!.trim()
  if (path === '') return spritePath
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return path
  const joined = path.startsWith('/') || spritePath === ''
    ? path
    : `${spritePath.slice(0, spritePath.lastIndexOf('/') + 1)}${path}`
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
    else if (part === '..' && joined.startsWith('/')) continue
    else parts.push(part)
  }
  return `${joined.startsWith('/') ? '/' : ''}${parts.join('/')}`
}

function spriteRoot(path: string, state: InlineState): Element | null {
  if (state.sprites.has(path)) return state.sprites.get(path) ?? null
  const source = state.loadSvgSprite?.(path) ?? null
  let root: Element | null = null
  if (source !== null) {
    try {
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
      root = parsed.documentElement?.localName === 'svg' ? parsed.documentElement : null
    } catch (_err) {
      // A malformed sprite file resolves nothing; its refs are reported as unresolved.
      root = null
    }
  }
  state.sprites.set(path, root)
  return root
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

/**
 * Clone `node` into the page document, charging one unit per node and per
 * attribute and collecting what `expandUse` needs (rule 3). Returns `null`
 * when the work runs out; comments and other node types are skipped
 * (`undefined`).
 */
function cloneTracked(node: Node, out: Collected, state: InlineState): Node | null | undefined {
  if (node.nodeType === TEXT_NODE) {
    return charge(state, 1) ? state.doc.createTextNode(node.textContent ?? '') : null
  }
  if (node.nodeType !== ELEMENT_NODE) return undefined
  const el = node as Element
  if (!charge(state, 1 + el.attributes.length)) return null
  const copy = state.doc.createElementNS(el.namespaceURI, el.localName)
  for (const attr of Array.from(el.attributes)) {
    if (attr.namespaceURI) copy.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
    else copy.setAttribute(attr.name, attr.value)
  }
  recordElement(copy, out)
  for (const child of Array.from(el.childNodes)) {
    const childCopy = cloneTracked(child, out, state)
    if (childCopy === null) return null
    if (childCopy) copy.appendChild(childCopy)
  }
  if (copy.localName === 'style') collectUrlReferences(copy.textContent ?? '', out)
  return copy
}

/** Note what a freshly cloned element contributes: nested uses, ids, references. */
function recordElement(el: Element, out: Collected): void {
  out.elements.push(el)
  if (el.localName === 'use') out.uses.push(el)
  if (el.localName === 'style') out.styles.push(el)
  if (el.hasAttribute('id')) out.idOwners.push(el)
  for (const attr of Array.from(el.attributes)) collectUrlReferences(attr.value, out)
  const hrefKind = HREF_KIND[el.localName]
  const href = hrefKind ? referenceOf(el) : ''
  if (href.startsWith('#')) out.references.push([decodeFragment(href.slice(1)), hrefKind!])
}

function collectUrlReferences(text: string, out: Collected): void {
  if (!text.includes('url(')) return
  for (const match of text.matchAll(URL_REFERENCE)) out.references.push([decodeFragment(match[2]!), 'definition'])
}

function cloneChildrenInto(parent: Element, from: Element, out: Collected, state: InlineState): boolean {
  for (const child of Array.from(from.childNodes)) {
    const copy = cloneTracked(child, out, state)
    if (copy === null) return false
    if (copy) parent.appendChild(copy)
  }
  return true
}

function copyForUse(use: Element, target: Element, out: Collected, state: InlineState): Element | null {
  if (!charge(state, 1 + use.attributes.length + target.attributes.length)) return null
  if (target.localName === 'symbol') {
    const box = state.doc.createElementNS(SVG_NS, 'svg')
    // The symbol's own attributes (its box, and presentation such as `fill`)
    // apply to what it draws; the `<use>`'s attributes then size and style it.
    for (const attr of Array.from(target.attributes)) {
      if (attr.name !== 'id') box.setAttribute(attr.name, attr.value)
    }
    recordElement(box, out)
    return cloneChildrenInto(box, target, out, state) ? box : null
  }

  const group = state.doc.createElementNS(SVG_NS, 'g')
  copyUseAttributes(use, group, (name) => !USE_GEOMETRY_ATTRIBUTES.has(name))
  appendTransform(group, offsetOf(use))
  const copy = cloneTracked(target, out, state)
  if (!copy) return null
  ;(copy as Element).removeAttribute('id')
  out.idOwners = out.idOwners.filter((owner) => owner !== copy)
  group.appendChild(copy)
  return group
}

/**
 * A copy for a `<use>` inside `<clipPath>`: the shape itself, with the
 * `<use>`'s transform and offset in front of its own and the `<use>`'s
 * presentation attributes where the shape sets none.
 */
function copyShapeForUse(use: Element, target: Element, out: Collected, state: InlineState): Element | null {
  const copy = cloneTracked(target, out, state) as Element | null | undefined
  if (!copy || !charge(state, use.attributes.length)) return null
  copy.removeAttribute('id')
  out.idOwners = out.idOwners.filter((owner) => owner !== copy)
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
 * Copy into `copy` (as `<defs>`) every definition it references that lives
 * elsewhere in `source`: a symbol's gradient usually sits in the sprite's
 * top-level `<defs>`. A worklist (rule 3): the references of each appended
 * definition were collected while cloning it and join the queue, so nothing
 * is scanned twice. Returns false when the work runs out.
 */
function copyReferencedDefinitions(copy: Element, source: Element, out: Collected, state: InlineState): boolean {
  const present = new Set(out.idOwners.map((owner) => owner.getAttribute('id')!))
  const queue = [...out.references]
  let defs: Element | null = null
  while (queue.length > 0) {
    const [id, kind] = queue.pop()!
    if (present.has(id)) continue
    present.add(id)
    if (!charge(state, 1)) return false
    const definition = source.ownerDocument.getElementById(id)
    if (!definition || definition.namespaceURI !== SVG_NS || !REFERENCE_KINDS[kind].has(definition.localName)) continue
    const before = out.references.length
    const clone = cloneTracked(definition, out, state)
    if (!clone) return false
    defs ??= copy.insertBefore(state.doc.createElementNS(SVG_NS, 'defs'), copy.firstChild)
    defs.appendChild(clone)
    queue.push(...out.references.slice(before))
  }
  return true
}

/**
 * A `<style>` inside a symbol is page CSS once the copy lands. Keep it in the
 * first copy of an external symbol; keep later copies only when renamed ids
 * changed their CSS. A same-page symbol's original CSS is already on the page.
 */
function keepStyleOnce(out: Collected, originals: (string | null)[], key: string, samePage: boolean, state: InlineState): void {
  if (out.styles.length === 0) return
  if (!samePage && !state.styledSymbols.has(key)) {
    state.styledSymbols.add(key)
    return
  }
  for (const [i, style] of out.styles.entries()) {
    // Styles referencing copy-local ids must accompany every renamed copy.
    if (style.textContent === originals[i]) style.remove()
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
 * and point the copy's own references at the new names: `url()`, non-`<use>`
 * `href`, SMIL `begin` / `end` syncbases, ARIA id lists and a kept `<style>`.
 * `<use>` hrefs keep their original names: they resolve against the source.
 */
function makeIdsUnique(out: Collected, state: InlineState): void {
  if (out.idOwners.length === 0) return
  let suffix = randomSuffix()
  while (out.idOwners.some((owner) => {
    const next = `${owner.getAttribute('id')}-${suffix}`
    return state.takenIds.has(next) || state.doc.getElementById(next) !== null
  })) suffix = randomSuffix()
  const renamed = new Map<string, string>()
  for (const owner of out.idOwners) {
    const id = owner.getAttribute('id')!
    const next = `${id}-${suffix}`
    renamed.set(id, next)
    state.takenIds.add(next)
    owner.setAttribute('id', next)
  }
  const renameUrls = (value: string) => value.replace(URL_REFERENCE, (whole, quote: string, id: string) => {
    const next = renamed.get(decodeFragment(id))
    return next ? `url(${quote}#${next}${quote})` : whole
  })
  for (const el of out.elements) {
    for (const attr of Array.from(el.attributes)) {
      if (el.localName === 'use' && USE_REFERENCE_ATTRIBUTES.has(attr.name)) continue
      let value = renameUrls(attr.value)
      if (USE_REFERENCE_ATTRIBUTES.has(attr.name) && value.startsWith('#')) {
        value = `#${renamed.get(decodeFragment(value.slice(1))) ?? value.slice(1)}`
      }
      if (SMIL_TIMING_ATTRIBUTES.has(attr.name)) value = renameSyncbases(value, renamed)
      if (ID_LIST_ATTRIBUTES.has(attr.name)) value = value.split(/\s+/).map((id) => renamed.get(id) ?? id).join(' ')
      if (value !== attr.value) el.setAttribute(attr.name, value)
    }
  }
  for (const style of out.styles) {
    style.textContent = renameUrls(style.textContent ?? '')
      .replace(/#(-?[A-Za-z_][\w-]*)/g, (whole, id: string) => (renamed.has(id) ? `#${renamed.get(id)}` : whole))
  }
}

/**
 * `a1.end; dot.click+1s` → each `<id>.` that was renamed, renamed. Only an
 * id followed by an event or syncbase name (a letter after the dot) counts,
 * so a clock value such as `0.5s` is never read as id `0`.
 */
function renameSyncbases(value: string, renamed: ReadonlyMap<string, string>): string {
  return value
    .split(';')
    .map((part) => part.replace(/^(\s*)([^.\s;]+)\.(?=[A-Za-z])/, (whole, lead: string, id: string) => {
      const next = renamed.get(id)
      return next ? `${lead}${next}.` : whole
    }))
    .join(';')
}
