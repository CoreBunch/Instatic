/**
 * Site fragment — the one portable format for "a piece of an Instatic site".
 *
 * A fragment carries a section (one or more sibling subtrees), a whole page,
 * or a Visual Component, together with everything it needs to render the same
 * in any other Instatic site: the style rules its nodes use and the ambient
 * rules built on them, the conditions those rules key on, the Visual Component
 * closure, the design tokens the styles reference (with their source
 * definitions), the data tables its loops and forms read, the media it shows,
 * and the internal page links it contains.
 *
 * Every id inside a fragment is a SOURCE id: node ids, rule ids, component
 * ids, table ids and media ids are whatever the source site used. The insert
 * planner (`planFragmentInsert`) mints fresh ids for everything it adds, so a
 * fragment never collides with the site it lands in.
 *
 * Media bytes are never inlined: `media[].src` says where the bytes are (a
 * path inside a fragment package zip, or a URL the caller resolves), and
 * `media[].path` is the exact string the fragment's nodes, rules and fonts use
 * to reference that asset, so the insert can rewrite every reference to the
 * uploaded copy.
 *
 * `parseSiteFragment` is the boundary: TypeBox for the shape, then the
 * invariants JSON Schema cannot express (roots resolve, trees are acyclic,
 * kind-specific payloads are present).
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { compiledSafeParseValue } from '@core/utils/typeboxCompiler'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  ConditionDefSchema,
  PageNodeSchema,
  StyleRuleSchema,
  assertValidNodeTree,
  type PageNode,
} from '@core/page-tree'
import { VisualComponentSchema } from '@core/visual-components-schema'
import { FrameworkColorTokenSchema } from '@core/framework-schema'
import { FontEntrySchema, FontTokenSchema } from '@core/fonts'
import { DataFieldSchema } from '@core/data/schemas'

export const SITE_FRAGMENT_FORMAT = 'instatic-fragment'
export const SITE_FRAGMENT_VERSION = 1

const FragmentKindSchema = Type.Union([
  Type.Literal('section'),
  Type.Literal('page'),
  Type.Literal('component'),
])
export type FragmentKind = Static<typeof FragmentKindSchema>

/** Free-form provenance: which library, item and build produced the fragment. */
const FragmentOriginSchema = Type.Object({
  source: Type.Optional(Type.String()),
  item: Type.Optional(Type.String()),
  build: Type.Optional(Type.String()),
})

/**
 * One step of a fluid typography or spacing scale the fragment's styles
 * reference, named the way the framework names it: the group's
 * `namingConvention` (`text`, `space`) plus the step label (`xl`, `3xs`).
 */
const FragmentScaleStepSchema = Type.Object({
  convention: Type.String({ minLength: 1 }),
  step: Type.String({ minLength: 1 }),
})
export type FragmentScaleStep = Static<typeof FragmentScaleStepSchema>

const FragmentTokensSchema = Type.Object({
  /** Full colour token definitions, generation flags included. */
  colors: Type.Array(FrameworkColorTokenSchema),
  /** Font tokens referenced through `var(--font-*)`. */
  fontTokens: Type.Array(FontTokenSchema),
  /** The font library entries those tokens bind to. */
  fontFamilies: Type.Array(FontEntrySchema),
  typeSteps: Type.Array(FragmentScaleStepSchema),
  spaceSteps: Type.Array(FragmentScaleStepSchema),
  /** Other `--custom-properties` the styles use, valued from the source root. */
  customProperties: Type.Record(Type.String(), Type.String()),
})
export type FragmentTokens = Static<typeof FragmentTokensSchema>

const FragmentTableRowSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  slug: Type.String(),
  status: Type.Union([Type.Literal('draft'), Type.Literal('published')]),
  cells: Type.Record(Type.String(), Type.Unknown()),
})
export type FragmentTableRow = Static<typeof FragmentTableRowSchema>

/**
 * A data table the fragment's loops or CMS forms read. `id` is the source
 * table id the fragment's nodes reference (`filters.tableId`,
 * `targetTableId`). Loops carry their rows; forms carry the schema only.
 */
const FragmentTableSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal('postType'), Type.Literal('data')]),
  singularLabel: Type.String(),
  pluralLabel: Type.String(),
  routeBase: Type.String(),
  primaryFieldId: Type.String(),
  fields: Type.Array(DataFieldSchema),
  rows: Type.Optional(Type.Array(FragmentTableRowSchema)),
})
export type FragmentTable = Static<typeof FragmentTableSchema>

const FragmentMediaSchema = Type.Object({
  /** Source media id — what media cells of carried rows hold. */
  id: Type.String({ minLength: 1 }),
  /** SHA-256 of the bytes, lowercase hex. Absent when the extractor had no bytes. */
  key: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
  /** The exact reference string the fragment content uses (`/uploads/…`). */
  path: Type.String({ minLength: 1 }),
  filename: Type.String({ minLength: 1 }),
  mimeType: Type.String({ minLength: 1 }),
  sizeBytes: Type.Optional(Type.Number({ minimum: 0 })),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  alt: Type.Optional(Type.String()),
  /** Where the bytes come from: a path inside the package zip, or a URL. */
  src: Type.String({ minLength: 1 }),
})
export type FragmentMedia = Static<typeof FragmentMediaSchema>

/** A `cms:page:<id>` link target found in the fragment, with the source slug. */
const FragmentLinkSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  slug: Type.String(),
})
export type FragmentLink = Static<typeof FragmentLinkSchema>

/**
 * A rule outside the fragment that styled the selection through a class on
 * one of its ancestors (a page wrapper, the body's site class). The fragment
 * does not carry it — inserted elsewhere, that styling is gone — so the
 * extractor records it and the insert report repeats it.
 */
const FragmentOutsideDependencySchema = Type.Object({
  selector: Type.String(),
  /** The ancestor-only class names the selector depends on. */
  classes: Type.Array(Type.String()),
})
export type FragmentOutsideDependency = Static<typeof FragmentOutsideDependencySchema>

export const SiteFragmentSchema = Type.Object({
  format: Type.Literal(SITE_FRAGMENT_FORMAT),
  version: Type.Literal(SITE_FRAGMENT_VERSION),
  kind: FragmentKindSchema,
  origin: Type.Optional(FragmentOriginSchema),
  /**
   * Ordered root node ids inside `nodes`. A section has 1..n sibling roots; a
   * page has exactly one, its `base.body`; a component has one
   * `base.visual-component-ref` instance of `component.id`.
   */
  roots: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  nodes: Type.Record(Type.String(), PageNodeSchema),
  page: Type.Optional(Type.Object({
    title: Type.String(),
    slug: Type.String(),
  })),
  component: Type.Optional(Type.Object({
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
  })),
  /**
   * Class rules the nodes use (framework classes by name only — their styles
   * are regenerated by the target), scoped module-style rules, and every
   * ambient rule whose selector names a carried class.
   */
  styleRules: Type.Array(StyleRuleSchema),
  conditions: Type.Array(ConditionDefSchema),
  /** Visual Component closure, nested references included. */
  components: Type.Array(VisualComponentSchema),
  tokens: FragmentTokensSchema,
  tables: Type.Array(FragmentTableSchema),
  media: Type.Array(FragmentMediaSchema),
  links: Type.Array(FragmentLinkSchema),
  outsideDependencies: Type.Optional(Type.Array(FragmentOutsideDependencySchema)),
})

export type SiteFragment = Static<typeof SiteFragmentSchema>

/** A fragment failed validation. `path` points at the offending value. */
export class FragmentParseError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'FragmentParseError'
    this.path = path
  }
}

const VIRTUAL_ROOT_ID = '\u0000fragment-root'

/**
 * Validate an untrusted value as a `SiteFragment`. Throws `FragmentParseError`
 * on the first problem; returns the typed fragment otherwise.
 */
export function parseSiteFragment(value: unknown): SiteFragment {
  const result = compiledSafeParseValue(SiteFragmentSchema, value)
  if (!result.ok) {
    const first = result.errors[0]
    throw new FragmentParseError(first?.path || 'fragment', first?.message ?? 'Invalid fragment')
  }
  const fragment = result.value
  assertFragmentTree(fragment)
  assertKindPayload(fragment)
  assertComponentTrees(fragment)
  assertUniqueIds(fragment)
  return fragment
}

function assertFragmentTree(fragment: SiteFragment): void {
  for (const rootId of fragment.roots) {
    if (!fragment.nodes[rootId]) {
      throw new FragmentParseError('roots', `root node "${rootId}" not found in nodes`)
    }
  }
  if (new Set(fragment.roots).size !== fragment.roots.length) {
    throw new FragmentParseError('roots', 'root ids must be unique')
  }
  // A virtual parent over every root lets the shared tree invariant check
  // (key/id parity, resolvable children, no reachable cycles) run unchanged.
  const virtualRoot: PageNode = {
    id: VIRTUAL_ROOT_ID,
    moduleId: 'base.body',
    props: {},
    breakpointOverrides: {},
    children: [...fragment.roots],
    classIds: [],
  }
  assertTree({ nodes: { ...fragment.nodes, [VIRTUAL_ROOT_ID]: virtualRoot }, rootNodeId: VIRTUAL_ROOT_ID }, 'nodes')
}

function assertTree(tree: Parameters<typeof assertValidNodeTree>[0], path: string): void {
  try {
    assertValidNodeTree(tree, path)
  } catch (err) {
    throw new FragmentParseError(path, getErrorMessage(err, String(err)))
  }
}

function assertKindPayload(fragment: SiteFragment): void {
  if (fragment.kind === 'page') {
    if (!fragment.page) throw new FragmentParseError('page', 'a page fragment needs page.title and page.slug')
    const root = fragment.roots.length === 1 ? fragment.nodes[fragment.roots[0]] : undefined
    if (!root || root.moduleId !== 'base.body') {
      throw new FragmentParseError('roots', 'a page fragment has exactly one root, its base.body')
    }
  }
  if (fragment.kind === 'component') {
    const component = fragment.component
    if (!component) throw new FragmentParseError('component', 'a component fragment needs component.id and component.name')
    if (!fragment.components.some((vc) => vc.id === component.id)) {
      throw new FragmentParseError('component.id', `component "${component.id}" is not in components`)
    }
    const root = fragment.roots.length === 1 ? fragment.nodes[fragment.roots[0]] : undefined
    if (
      !root
      || root.moduleId !== 'base.visual-component-ref'
      || root.props.componentId !== component.id
    ) {
      throw new FragmentParseError('roots', 'a component fragment has exactly one root, an instance of the component')
    }
  }
}

function assertComponentTrees(fragment: SiteFragment): void {
  fragment.components.forEach((vc, index) => assertTree(vc.tree, `components.${index}.tree`))
}

function assertUniqueIds(fragment: SiteFragment): void {
  const checks: [string, string[]][] = [
    ['components', fragment.components.map((vc) => vc.id)],
    ['styleRules', fragment.styleRules.map((rule) => rule.id)],
    ['tables', fragment.tables.map((table) => table.id)],
    ['media', fragment.media.map((media) => media.id)],
  ]
  for (const [path, ids] of checks) {
    if (new Set(ids).size !== ids.length) {
      throw new FragmentParseError(path, 'ids must be unique')
    }
  }
}
