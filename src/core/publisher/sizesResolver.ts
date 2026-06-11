/**
 * Publisher — automatic `sizes` resolver.
 *
 * The publisher generates the site's CSS, so it can compute what the browser
 * will lay out instead of asking the author to predict it. The image module
 * always emits the resolved value (`auto, <resolved>` on lazy images, the
 * resolved value alone on eager ones) — there is no user-facing `sizes` knob.
 *
 * Model: walking the ancestor chain ROOT → IMAGE, every node's width is
 * `min(…)` over a set of LINEAR functions of the viewport (`a·vw + b px`),
 * plus an optional px FLOOR (from `min-width`) emitted as a `max()` wrapper.
 * Every supported CSS construct preserves linearity:
 *
 *   - `width` / `max-width` in px → a constant candidate (`a=0`).
 *   - `width: P%` / `max-width: P%` → scales every candidate by P/100.
 *   - `width: Nvw` → replaces the set with the viewport term.
 *   - `min-width: Npx` → raises the floor (rendered as `max(Npx, …)`).
 *   - px paddings → subtract from the content box (published CSS is
 *     border-box).
 *   - grid columns → the child's track share: px tracks are constants, `%`
 *     tracks scale the FULL content box (gaps overflow, they don't shrink
 *     a % track), `fr` tracks split the leftover after gaps + fixed +
 *     percentage tracks — all linear transforms.
 *
 * The final set renders as exact CSS math (`min(33.33vw - 16px, 410.67px)`),
 * valid inside a `sizes` attribute. Anything the model can't express
 * degrades in the SAFE direction — the estimate may only grow (heavier
 * download), never shrink (blurry render):
 *
 *   - flex rows are content-driven → the child keeps the container width
 *     unless it declares its own width.
 *   - unparsable grid track lists (auto-fit/auto-fill/minmax), an fr track
 *     whose sibling percentage tracks leave no leftover (≥ 100%), explicit
 *     `gridColumn` placement on the child OR any visible sibling →
 *     container width.
 *   - UNEQUAL track lists are only trusted when auto-placement is
 *     predictable: hidden siblings are excluded from the item index, and a
 *     `base.loop` grid (whose copies round-robin the tracks) bails. Equal
 *     track lists are exact regardless of placement.
 *   - non-px paddings/gaps → treated as 0.
 *   - a non-px `min-width` → that node's own narrowing is skipped.
 *   - candidate sets are capped at 4 terms (dropping `min()` arguments only
 *     raises the result).
 *
 * Cascade fidelity: classes merge in `styleRule.order` (the published
 * stylesheet's source order — NOT the node's classIds order), and
 * `node.inlineStyles` merge last (the publisher injects them as a literal
 * `style` attribute, which outranks every class).
 *
 * Per-viewport overrides emit one `sizes` candidate per breakpoint tier
 * using that breakpoint's media query, ordered for first-match semantics
 * (reverse of CSS cascade precedence). Tiers that equal their next emitted
 * tier collapse ONLY when every query is uniformly nested (all default-form
 * `max-width` or all `min-width`) — with mixed directions the neighbour
 * covers a disjoint viewport range and dropping a tier would fall through
 * to the wrong value. Each tier is evaluated as base styles + THAT
 * breakpoint's overrides — the same single-override approximation the
 * published-CSS cascade ordering makes unambiguous for the common
 * narrowing patterns.
 *
 * Returns `null` only when nothing in the chain constrains the image at any
 * tier — the caller falls back to `100vw`.
 */
import { breakpointMediaQuery, type Page, type PageNode, type SiteDocument } from '@core/page-tree'
import { compareViewportContextCascade } from './classCss'

// ---------------------------------------------------------------------------
// Linear width candidates
// ---------------------------------------------------------------------------

/** One linear width term: `width(viewport) = vw · viewport + px`. */
interface WidthTerm {
  /** Viewport coefficient as a fraction (1 = 100vw). */
  vw: number
  /** Pixel offset — negative for gap/padding subtractions. */
  px: number
}

/** The node's width: `max(floor, min(candidate terms))`. */
interface WidthState {
  cands: WidthTerm[]
  /** px floor from `min-width` constraints; 0 = no floor. */
  floor: number
}

const FULL_VIEWPORT: WidthTerm[] = [{ vw: 1, px: 0 }]

/**
 * Reference viewports for capping the candidate set: keeping the minimal
 * term at each reference keeps the estimate exact there and only raises it
 * elsewhere. Bounds the emitted attribute (≤ 4 `min()` arguments) no matter
 * how deep a %-cap + padding chain nests.
 */
const REFERENCE_VIEWPORTS = [360, 768, 1280, 1920]

function scale(cands: WidthTerm[], factor: number): WidthTerm[] {
  return cands.map((c) => ({ vw: c.vw * factor, px: c.px * factor }))
}

function offset(cands: WidthTerm[], px: number): WidthTerm[] {
  return cands.map((c) => ({ vw: c.vw, px: c.px + px }))
}

/**
 * Drop candidates that can never be the minimum (another candidate is ≤ in
 * BOTH coefficients), dedupe, and cap the set at the terms that achieve the
 * minimum at the reference viewports.
 */
function prune(cands: WidthTerm[]): WidthTerm[] {
  const out: WidthTerm[] = []
  for (const c of cands) {
    if (out.some((d) => d.vw <= c.vw && d.px <= c.px)) continue
    for (let i = out.length - 1; i >= 0; i--) {
      if (c.vw <= out[i].vw && c.px <= out[i].px) out.splice(i, 1)
    }
    out.push(c)
  }
  if (out.length <= REFERENCE_VIEWPORTS.length) return out
  const kept = new Set<WidthTerm>()
  for (const viewport of REFERENCE_VIEWPORTS) {
    let best = out[0]
    for (const c of out) {
      if (c.vw * viewport + c.px < best.vw * viewport + best.px) best = c
    }
    kept.add(best)
  }
  return [...kept]
}

// ---------------------------------------------------------------------------
// CSS value parsing
// ---------------------------------------------------------------------------

interface CssLength {
  unit: 'px' | 'pct' | 'vw'
  value: number
}

/**
 * Parse `"800px"` / `"800"` / `800` / `"50%"` / `"50vw"`. Returns `null` for
 * anything else (`auto`, `rem`, CSS functions, …) — callers decide whether
 * to skip the property or bail.
 */
function parseLength(value: unknown): CssLength | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? { unit: 'px', value } : null
  }
  if (typeof value !== 'string') return null
  const m = value.trim().match(/^(\d+(?:\.\d+)?)(px|%|vw)?$/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return { unit: m[2] === '%' ? 'pct' : m[2] === 'vw' ? 'vw' : 'px', value: n }
}

/** Parse a px-valued length; anything else (including %) returns 0. */
function pxOrZero(value: unknown): number {
  const parsed = parseLength(value)
  return parsed && parsed.unit === 'px' ? parsed.value : 0
}

// ---------------------------------------------------------------------------
// Grid track parsing
// ---------------------------------------------------------------------------

type GridTrack =
  | { kind: 'px'; value: number }
  | { kind: 'pct'; value: number }
  | { kind: 'fr'; value: number }

/**
 * Parse a `grid-template-columns` track list into px / % / fr tracks.
 * `repeat(N, …)` with a literal count is expanded. Anything else
 * (auto-fit/auto-fill, minmax(), auto, named lines) returns `null` — the
 * caller bails to the container width.
 */
function parseGridTracks(value: unknown): GridTrack[] | null {
  if (typeof value !== 'string' || !value.trim()) return null
  // Expand literal repeat(N, tracks) — nested functions inside repeat() are
  // unsupported and fail the token parse below.
  const expanded = value.replace(/repeat\(\s*(\d+)\s*,([^)]*)\)/g, (_m, count: string, inner: string) =>
    Array.from({ length: Number(count) }, () => inner.trim()).join(' '),
  )
  if (/repeat|minmax|auto|\(/.test(expanded)) return null
  const tokens = expanded.trim().split(/\s+/)
  const tracks: GridTrack[] = []
  for (const token of tokens) {
    const m = token.match(/^(\d+(?:\.\d+)?)(px|%|fr)$/)
    if (!m) return null
    const n = Number(m[1])
    if (!Number.isFinite(n) || n < 0) return null
    tracks.push({ kind: m[2] === '%' ? 'pct' : m[2] === 'fr' ? 'fr' : 'px', value: n })
  }
  return tracks.length ? tracks : null
}

/** Column gap in px: `columnGap` wins, else the 2nd value of `gap`, else its 1st. */
function columnGapPx(bag: Record<string, unknown>): number {
  if (bag.columnGap !== undefined) return pxOrZero(bag.columnGap)
  if (typeof bag.gap === 'string') {
    const parts = bag.gap.trim().split(/\s+/)
    return pxOrZero(parts[1] ?? parts[0])
  }
  return pxOrZero(bag.gap)
}

// ---------------------------------------------------------------------------
// Effective style bags per viewport tier
// ---------------------------------------------------------------------------

/**
 * Merge a node's styles into one effective bag for a tier, mirroring the
 * published cascade: classes in `styleRule.order` (stylesheet source order —
 * generateClassCSS sorts by it, and with equal class specificity the later
 * stylesheet rule wins, NOT the later classId), each class's
 * `contextStyles[breakpointId]` over its base, and `node.inlineStyles` last
 * (injected as a literal `style` attribute, outranking every class).
 */
function effectiveBag(
  node: PageNode,
  site: SiteDocument,
  breakpointId: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const classes = (node.classIds ?? [])
    .map((classId) => site.styleRules[classId])
    .filter((cls) => cls !== undefined)
    .sort((a, b) => (typeof a.order === 'number' ? a.order : 0) - (typeof b.order === 'number' ? b.order : 0))
  for (const cls of classes) {
    Object.assign(out, cls.styles)
    if (breakpointId) Object.assign(out, cls.contextStyles?.[breakpointId])
  }
  if (node.inlineStyles) Object.assign(out, node.inlineStyles)
  return out
}

// ---------------------------------------------------------------------------
// The chain walk
// ---------------------------------------------------------------------------

/**
 * Walk from `nodeId` outward, then reverse: `[root, …, parent, image]`.
 * Uses the node's denormalised `parentId` pointer (O(depth)); every page
 * reaching the publisher — real, synthetic VC, or composed template — has
 * its parentId index derived first.
 */
function chainRootToNode(nodeId: string, page: Page): PageNode[] {
  const out: PageNode[] = []
  const visited = new Set<string>()
  let current: string | null | undefined = nodeId
  while (current && !visited.has(current)) {
    visited.add(current)
    const node: PageNode | undefined = page.nodes[current]
    if (!node) break
    out.push(node)
    current = node.parentId
  }
  return out.reverse()
}

interface TierContext {
  page: Page
  site: SiteDocument
  breakpointId: string | null
}

/**
 * Whether auto-placement reliably maps the child to `index % nCols`:
 * only rendered siblings occupy grid cells (hidden nodes emit nothing),
 * explicit `gridColumn` placement on any of them shifts the flow, and a
 * `base.loop` grid renders N copies of its template that round-robin the
 * tracks. Equal track lists don't need this check — every column has the
 * same width.
 */
function placementTrustworthy(
  parent: PageNode,
  visibleChildren: string[],
  ctx: TierContext,
): boolean {
  if (parent.moduleId === 'base.loop') return false
  for (const id of visibleChildren) {
    const sibling = ctx.page.nodes[id]
    if (!sibling) return false
    if (effectiveBag(sibling, ctx.site, ctx.breakpointId).gridColumn !== undefined) return false
  }
  return true
}

/**
 * The width available to `child` inside `parent` — the parent's content box,
 * split by the parent's layout when it can be modelled linearly.
 */
function childAvailableWidth(
  state: WidthState,
  parentBag: Record<string, unknown>,
  parent: PageNode,
  child: PageNode,
  ctx: TierContext,
): WidthState {
  // Content box: published CSS is border-box, so px paddings shrink what the
  // children can occupy. Non-px paddings are treated as 0 (over-estimate).
  const padding = pxOrZero(parentBag.paddingLeft) + pxOrZero(parentBag.paddingRight)
  const cands = padding > 0 ? offset(state.cands, -padding) : state.cands
  const floor = Math.max(0, state.floor - padding)

  if (parentBag.display === 'grid') {
    const tracks = parseGridTracks(parentBag.gridTemplateColumns)
    if (!tracks) return { cands, floor }

    const equalTracks = tracks.every((t) => t.kind === tracks[0].kind && t.value === tracks[0].value)
    // Hidden siblings render nothing and occupy no grid cell.
    const visibleChildren = parent.children.filter((id) => !ctx.page.nodes[id]?.hidden)
    const index = visibleChildren.indexOf(child.id)
    if (index < 0) return { cands, floor }
    if (!equalTracks && !placementTrustworthy(parent, visibleChildren, ctx)) {
      return { cands, floor }
    }
    const track = tracks[index % tracks.length]

    // Percentage tracks resolve against the FULL content box — gaps cause
    // overflow in CSS, they never shrink a % track.
    if (track.kind === 'px') return { cands: [{ vw: 0, px: track.value }], floor: 0 }
    if (track.kind === 'pct') {
      return { cands: scale(cands, track.value / 100), floor: floor * (track.value / 100) }
    }

    // fr track: share of the leftover after % tracks scale and px tracks +
    // gaps subtract — still linear. Percentage tracks summing to ≥ 100%
    // leave no (or negative) leftover — bail before the math goes
    // non-physical (a negative <source-size-value> is invalid HTML).
    const pctSum = tracks.reduce((sum, t) => sum + (t.kind === 'pct' ? t.value / 100 : 0), 0)
    if (pctSum >= 1) return { cands, floor }
    const gaps = columnGapPx(parentBag) * (tracks.length - 1)
    const pxSum = tracks.reduce((sum, t) => sum + (t.kind === 'px' ? t.value : 0), 0)
    const frTotal = tracks.reduce((sum, t) => sum + (t.kind === 'fr' ? t.value : 0), 0)
    if (frTotal <= 0) return { cands, floor }
    const share = track.value / frTotal
    let leftover = pctSum > 0 ? scale(cands, 1 - pctSum) : cands
    if (pxSum + gaps > 0) leftover = offset(leftover, -(pxSum + gaps))
    return {
      cands: scale(leftover, share),
      floor: Math.max(0, (floor * (1 - pctSum) - pxSum - gaps) * share),
    }
  }

  // Flex rows are content-driven; without solving the full flex algorithm the
  // container width is the safe (over-)estimate. The child's own width /
  // max-width still applies afterwards. Flex columns give full width anyway.
  return { cands, floor }
}

/** Apply the node's OWN `width` / `max-width` / `min-width`. */
function applyOwnWidth(state: WidthState, bag: Record<string, unknown>): WidthState {
  // A floor the model can't express (`min-width: 30rem`) means this node may
  // be WIDER than its declared width — skip the node's own narrowing
  // entirely rather than under-estimate.
  if (bag.minWidth !== undefined) {
    const parsed = parseLength(bag.minWidth)
    const isNone = typeof bag.minWidth === 'string' && /^(0(px)?|none|auto)$/.test(bag.minWidth.trim())
    if (!parsed && !isNone) return state
    if (parsed && parsed.unit !== 'px') return state
  }

  const parentCands = state.cands
  let out = state.cands
  let floor = state.floor

  const width = parseLength(bag.width)
  if (width) {
    if (width.unit === 'px') {
      out = [{ vw: 0, px: width.value }]
      floor = 0
    } else if (width.unit === 'pct') {
      out = scale(parentCands, width.value / 100)
      floor = floor * (width.value / 100)
    } else {
      out = [{ vw: width.value / 100, px: 0 }]
      floor = 0
    }
  }

  const maxWidth = parseLength(bag.maxWidth)
  if (maxWidth) {
    if (maxWidth.unit === 'px') out = [...out, { vw: 0, px: maxWidth.value }]
    else if (maxWidth.unit === 'pct') out = [...out, ...scale(parentCands, maxWidth.value / 100)]
    else out = [...out, { vw: maxWidth.value / 100, px: 0 }]
  }

  const minWidth = parseLength(bag.minWidth)
  if (minWidth && minWidth.unit === 'px') floor = Math.max(floor, minWidth.value)

  return { cands: prune(out), floor }
}

/** Resolve the image's width state for one viewport tier. */
function tierWidth(chain: PageNode[], ctx: TierContext): WidthState {
  let state: WidthState = { cands: FULL_VIEWPORT, floor: 0 }
  let parent: { node: PageNode; bag: Record<string, unknown> } | null = null
  for (const node of chain) {
    const bag = effectiveBag(node, ctx.site, ctx.breakpointId)
    if (parent) state = childAvailableWidth(state, parent.bag, parent.node, node, ctx)
    state = applyOwnWidth(state, bag)
    parent = { node, bag }
  }
  return { cands: prune(state.cands), floor: state.floor }
}

// ---------------------------------------------------------------------------
// Rendering candidates → CSS `sizes` source values
// ---------------------------------------------------------------------------

/** `33.3333…` → `'33.33'`, `50` → `'50'`. */
function fmtNumber(n: number): string {
  return String(parseFloat(n.toFixed(2)))
}

/** One linear term as raw CSS math (`100vw - 80px`, `410.67px`, `50vw`). */
function fmtTerm(term: WidthTerm): string {
  const vw = term.vw !== 0 ? `${fmtNumber(term.vw * 100)}vw` : null
  const px = term.px !== 0 || !vw ? `${fmtNumber(Math.abs(term.px))}px` : null
  if (vw && px) return `${vw} ${term.px < 0 ? '-' : '+'} ${px}`
  return vw ?? px ?? '0px'
}

/** Render a width state as a `sizes` source value. */
function renderWidth(state: WidthState): string {
  // Guard rail: negative-coefficient or never-positive terms are artifacts
  // of degenerate inputs — a negative <source-size-value> is invalid HTML.
  // Dropping them (or falling back to the viewport) only over-estimates.
  const cands = state.cands.filter((c) => c.vw >= 0 && !(c.vw === 0 && c.px <= 0))
  const safe = cands.length ? cands : FULL_VIEWPORT

  let inner: string
  if (safe.length === 1) {
    const term = safe[0]
    const raw = fmtTerm(term)
    // Mixed vw+px terms need calc() when they stand alone; min()/max()
    // arguments accept raw math.
    inner = term.vw !== 0 && term.px !== 0 && state.floor <= 0 ? `calc(${raw})` : raw
  } else {
    inner = `min(${safe.map(fmtTerm).join(', ')})`
  }

  // The floor only matters when some candidate can dip below it (any
  // viewport-dependent term, or a constant smaller than the floor).
  const floorMatters = state.floor > 0
    && safe.some((c) => c.vw > 0 || c.px < state.floor)
  return floorMatters ? `max(${fmtNumber(state.floor)}px, ${inner})` : inner
}

function isSafeSizesMediaQuery(query: string): boolean {
  return !/[{}]/.test(query) && !/<\//.test(query) && !/;/.test(query)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the `sizes` string for the image at `nodeId`, or `null` when the
 * layout doesn't constrain it at any tier (caller falls back to `100vw`).
 */
export function resolveAutoSizes(
  nodeId: string,
  page: Page,
  site: SiteDocument,
): string | null {
  const chain = chainRootToNode(nodeId, page)
  if (!chain.length) return null

  // Viewport tiers in `sizes` first-match order — the reverse of the CSS
  // cascade, so the candidate that would win in CSS is hit first.
  const tiers = site.breakpoints
    .map((breakpoint, index) => ({ breakpoint, index }))
    .sort(compareViewportContextCascade)
    .reverse()

  const entries: Array<{ query: string | null; value: string }> = []
  for (const { breakpoint } of tiers) {
    const query = breakpointMediaQuery(breakpoint)
    if (!isSafeSizesMediaQuery(query)) continue
    entries.push({ query, value: renderWidth(tierWidth(chain, { page, site, breakpointId: breakpoint.id })) })
  }
  entries.push({ query: null, value: renderWidth(tierWidth(chain, { page, site, breakpointId: null })) })

  // Collapse runs only when the queries are uniformly nested (all default
  // `max-width` or all `min-width`): there, the next emitted tier's range is
  // a superset, so an equal-valued tier is redundant under first-match
  // semantics. Mixed-direction queries cover disjoint ranges — dropping a
  // tier would fall through to a value CSS never renders.
  const queries = entries.slice(0, -1).map((e) => e.query ?? '')
  const uniformlyNested =
    queries.every((q) => /^\(max-width:\s*\d+(?:\.\d+)?px\)$/.test(q)) ||
    queries.every((q) => /^\(min-width:\s*\d+(?:\.\d+)?px\)$/.test(q))
  let kept = entries
  if (uniformlyNested) {
    kept = []
    for (let i = entries.length - 1; i >= 0; i--) {
      if (kept.length && kept[0].value === entries[i].value) continue
      kept.unshift(entries[i])
    }
  }

  if (kept.length === 1 && kept[0].value === '100vw') return null
  return kept
    .map((entry) => (entry.query ? `${entry.query} ${entry.value}` : entry.value))
    .join(', ')
}
