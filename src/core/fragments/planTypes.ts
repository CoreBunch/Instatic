/**
 * The insert plan and its report — what `planFragmentInsert` decides, what
 * `commitFragmentPlan` executes, and what the user is shown.
 */

import type { ConditionDef, PageNode, SiteDocument, StyleRule } from '@core/page-tree'
import type { FrameworkColorToken } from '@core/framework-schema'
import type { FontEntry, FontToken } from '@core/fonts'
import type { VisualComponent } from '@core/visualComponents'
import type { DataField, DataTable, DataTableKind } from '@core/data/schemas'
import type {
  FragmentKind,
  FragmentMedia,
  FragmentOutsideDependency,
  FragmentTableRow,
} from './schema'
import type { ScaleFamily } from './siteVariables'
import type { FragmentWarning } from './warnings'

/** The document a section or component lands in. */
export type FragmentInsertDocument =
  | { kind: 'page'; pageId: string }
  | { kind: 'visualComponent'; vcId: string }

export interface FragmentInsertTarget {
  site: SiteDocument
  /** The target's data tables (the editor store holds none; read them from the CMS API). */
  tables: readonly DataTable[]
  /** Where a section or component lands. A page fragment adds its own page. */
  document?: FragmentInsertDocument
}

/** A fragment table that lands on a table the site already has (matched by slug). */
export interface PlannedTableReuse {
  action: 'reuse'
  fragmentTableId: string
  tableId: string
  slug: string
  /** The table's current fields; `addFields` are appended to them. */
  existingFields: DataField[]
  addFields: DataField[]
}

/** A fragment table the site lacks: created with its schema and rows. */
export interface PlannedTableCreate {
  action: 'create'
  fragmentTableId: string
  slug: string
  input: {
    name: string
    slug: string
    kind: Extract<DataTableKind, 'postType' | 'data'>
    singularLabel: string
    pluralLabel: string
    routeBase: string
    primaryFieldId: string
    fields: DataField[]
  }
  rows: FragmentTableRow[]
}

export type PlannedTable = PlannedTableReuse | PlannedTableCreate

/** A font library entry the site lacks; the commit installs or registers it. */
export interface PlannedFontFamily {
  /** The family's id inside the fragment — planned font tokens bind to it until installed. */
  fragmentFamilyId: string
  entry: FontEntry
}

export interface PlannedScaleSteps {
  family: ScaleFamily
  groupId: string
  steps: string
  baseScaleIndex: number
}

/**
 * Root custom properties the site lacks. They live in ONE engine-owned
 * ambient `:root` rule (`origin.source === FRAGMENT_PROPERTIES_ORIGIN`): the
 * first insert creates it, later inserts add to it. A user-authored `:root`
 * rule is never edited.
 */
export interface PlannedCustomProperties {
  ruleId: string
  /** True when the rule does not exist yet. */
  create: boolean
  order: number
  properties: Record<string, string>
}

export interface FragmentInsertReport {
  kind: FragmentKind
  /** The page a page fragment adds, with its final (possibly suffixed) slug. */
  page?: { title: string; slug: string }
  /** Nodes placed in the document (component trees not counted). */
  nodes: number
  colors: { added: string[]; kept: string[] }
  fonts: { tokensAdded: string[]; tokensKept: string[]; familiesAdded: string[]; familiesKept: string[] }
  steps: { added: { family: ScaleFamily; convention: string; step: string }[] }
  customProperties: { added: string[]; kept: string[] }
  rules: { added: string[]; reused: string[]; ambientAdded: string[]; ambientKept: string[] }
  conditions: { added: string[] }
  components: { added: string[]; reused: string[] }
  tables: { created: string[]; reused: string[]; fieldsAdded: string[]; rows: number }
  media: { total: number; uploaded: number; reused: number }
  links: { remapped: string[]; unresolved: string[] }
  outsideDependencies: FragmentOutsideDependency[]
  warnings: FragmentWarning[]
}

/**
 * Everything an insert will add, with every id already minted. Media paths,
 * created-table ids and to-be-installed font family ids are still the
 * fragment's; `resolveFragmentPlan` rewrites them once the server work has
 * produced the real ones.
 */
export interface FragmentInsertPlan {
  kind: FragmentKind
  document?: FragmentInsertDocument
  page?: { id: string; title: string; slug: string }
  roots: string[]
  nodes: Record<string, PageNode>
  styleRules: StyleRule[]
  customProperties: PlannedCustomProperties | null
  conditions: ConditionDef[]
  colorTokens: FrameworkColorToken[]
  scaleSteps: PlannedScaleSteps[]
  fontFamilies: PlannedFontFamily[]
  fontTokens: FontToken[]
  components: VisualComponent[]
  tables: PlannedTable[]
  /** Media the inserted content references (rows of reused tables excluded). */
  media: FragmentMedia[]
  report: FragmentInsertReport
}
