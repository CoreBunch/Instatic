/**
 * What a planned change looks like, for the review page: which fields moved
 * (as display text), which page nodes were added, changed or removed, how a
 * table's schema differs, or a file's text on both sides. Computed from the
 * same content projections the merge compares, so the review never
 * disagrees with the plan.
 *
 * "before" is the receiving side (`into`), "after" the contributing side
 * (`from`) — main and the branch for a merge, the other way round for an
 * update.
 */
import { parsePageNode } from '@core/page-tree'
import { canonicalJson } from '@core/utils/canonicalJson'
import type {
  MergeChangeDetail,
  MergeFieldChange,
  MergeSchemaField,
  MergeTreeDiff,
} from '@core/branches'
import type { BranchEntityKind, FileContent, RowContent, SiteContent, TableContent } from './contentHash'

const PREVIEW_LIMIT = 240

/** Tables whose `body` cell is a node tree. */
const TREE_TABLES = new Set(['pages', 'components', 'layouts'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function displayValue(value: unknown): { text: string | null; structured: boolean } {
  if (value === undefined || value === null) return { text: null, structured: false }
  if (typeof value === 'string') return { text: value, structured: false }
  if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value), structured: false }
  const json = canonicalJson(value)
  return { text: json.length > PREVIEW_LIMIT ? `${json.slice(0, PREVIEW_LIMIT)}…` : json, structured: true }
}

interface FieldChangeOptions {
  /** Prefix that turns a key into the conflict path the merge reports. */
  prefix: string
  conflicts: ReadonlySet<string>
  skip?: ReadonlySet<string>
  labels?: Readonly<Record<string, string>>
}

function fieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: FieldChangeOptions,
): MergeFieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const out: MergeFieldChange[] = []
  for (const key of keys) {
    if (options.skip?.has(key)) continue
    const a = before[key]
    const b = after[key]
    if (canonicalJson(a ?? null) === canonicalJson(b ?? null)) continue
    const shownBefore = displayValue(a)
    const shownAfter = displayValue(b)
    const path = `${options.prefix}${key}`
    out.push({
      id: key,
      label: options.labels?.[key] ?? key,
      before: shownBefore.text,
      after: shownAfter.text,
      structured: shownBefore.structured || shownAfter.structured,
      // A conflict deeper inside a structured value still belongs to this field.
      conflict: [...options.conflicts].some((conflict) => conflict === path || conflict.startsWith(`${path}.`)),
    })
  }
  return out
}

/**
 * What "the same node" means for the diff: the node as the editor would load
 * it, minus its children (a child list change is the child's own add/remove).
 * Rows written outside the editor (the data API, an import) may store `{}`
 * maps or omit them; parsing both sides first keeps those from counting as
 * changes.
 */
function nodeSignature(node: unknown): string {
  if (!isRecord(node)) return canonicalJson(node ?? null)
  const { children: _children, ...rest } = normalizeNode(node)
  return canonicalJson(rest)
}

function normalizeNode(node: Record<string, unknown>): Record<string, unknown> {
  try {
    return parsePageNode(node, 'node')
  } catch {
    // A node the editor could not load is compared as stored.
    return node
  }
}

function nodeLabel(node: unknown): string {
  if (!isRecord(node)) return 'node'
  if (typeof node.label === 'string' && node.label.trim()) return node.label.trim()
  if (typeof node.moduleId === 'string') return node.moduleId.replace(/^base\./, '')
  return 'node'
}

/** Node-level diff of two `{ nodes, rootNodeId }` trees; null when neither side has one. */
export function treeDiff(before: unknown, after: unknown): MergeTreeDiff | null {
  const beforeNodes = isRecord(before) && isRecord(before.nodes) ? before.nodes : null
  const afterNodes = isRecord(after) && isRecord(after.nodes) ? after.nodes : null
  if (!beforeNodes && !afterNodes) return null
  const a = beforeNodes ?? {}
  const b = afterNodes ?? {}
  const diff: MergeTreeDiff = { added: [], changed: [], removed: [], labels: {} }
  for (const id of Object.keys(b)) {
    if (!(id in a)) {
      diff.added.push(id)
      diff.labels[id] = nodeLabel(b[id])
    } else if (nodeSignature(a[id]) !== nodeSignature(b[id])) {
      diff.changed.push(id)
      diff.labels[id] = nodeLabel(b[id])
    }
  }
  for (const id of Object.keys(a)) {
    if (!(id in b)) {
      diff.removed.push(id)
      diff.labels[id] = nodeLabel(a[id])
    }
  }
  return diff
}

function schemaFieldSummary(field: unknown): { id: string; label: string; type: string } | null {
  if (!isRecord(field) || typeof field.id !== 'string') return null
  const label = typeof field.label === 'string' && field.label.trim() ? field.label : field.id
  const type = typeof field.type === 'string' ? field.type : ''
  return { id: field.id, label, type }
}

function schemaDiff(before: readonly unknown[], after: readonly unknown[]): MergeSchemaField[] {
  const beforeById = new Map<string, unknown>()
  for (const field of before) {
    const summary = schemaFieldSummary(field)
    if (summary) beforeById.set(summary.id, field)
  }
  const out: MergeSchemaField[] = []
  const seen = new Set<string>()
  for (const field of after) {
    const summary = schemaFieldSummary(field)
    if (!summary) continue
    seen.add(summary.id)
    const previous = beforeById.get(summary.id)
    const status = previous === undefined
      ? 'new'
      : canonicalJson(previous) === canonicalJson(field) ? 'same' : 'changed'
    out.push({ ...summary, status })
  }
  for (const field of before) {
    const summary = schemaFieldSummary(field)
    if (summary && !seen.has(summary.id)) out.push({ ...summary, status: 'removed' })
  }
  return out
}

const ROW_LABELS: Record<string, string> = { title: 'Title', slug: 'Slug', body: 'Body' }
const TABLE_LABELS: Record<string, string> = {
  name: 'Name',
  slug: 'Slug',
  kind: 'Kind',
  routeBase: 'Route base',
  singularLabel: 'Singular label',
  pluralLabel: 'Plural label',
  primaryFieldId: 'Primary field',
}
const SITE_LABELS: Record<string, string> = {
  name: 'Site name',
  settings: 'Settings',
  breakpoints: 'Breakpoints',
  styleRules: 'Style rules',
  conditions: 'Conditions',
  explorer: 'Explorer organization',
  packageJson: 'package.json',
  runtime: 'Runtime',
}

/**
 * Describe the difference between the two sides of one entity. Either side
 * may be absent (a creation or a deletion).
 */
export function describeChange(
  kind: BranchEntityKind,
  tableId: string | null,
  before: unknown | undefined,
  after: unknown | undefined,
  conflicts: readonly string[],
): MergeChangeDetail {
  const conflictSet = new Set(conflicts)
  switch (kind) {
    case 'row': {
      const a = (before ?? null) as RowContent | null
      const b = (after ?? null) as RowContent | null
      const hasTree = tableId !== null && TREE_TABLES.has(tableId)
      const fields = fieldChanges(
        { ...(a?.cells ?? {}), slug: a?.slug },
        { ...(b?.cells ?? {}), slug: b?.slug },
        {
          prefix: 'cells.',
          conflicts: new Set([...conflictSet, ...(conflictSet.has('slug') ? ['cells.slug'] : [])]),
          skip: hasTree ? new Set(['body']) : undefined,
          labels: ROW_LABELS,
        },
      )
      return {
        kind: 'row',
        fields,
        tree: hasTree ? treeDiff(a?.cells.body, b?.cells.body) : null,
      }
    }
    case 'table': {
      const a = (before ?? null) as TableContent | null
      const b = (after ?? null) as TableContent | null
      const { fields: beforeFields = [], ...beforeSettings } = a ?? {}
      const { fields: afterFields = [], ...afterSettings } = b ?? {}
      return {
        kind: 'table',
        fields: fieldChanges(beforeSettings, afterSettings, { prefix: '', conflicts: conflictSet, labels: TABLE_LABELS }),
        schema: schemaDiff(beforeFields, afterFields),
      }
    }
    case 'site': {
      const a = (before ?? null) as SiteContent | null
      const b = (after ?? null) as SiteContent | null
      const shellConflicts = new Set<string>()
      for (const path of conflictSet) {
        shellConflicts.add(path.startsWith('shell.') ? path.slice('shell.'.length) : path)
      }
      return {
        kind: 'site',
        fields: fieldChanges(
          { name: a?.name, ...(a?.shell ?? {}) },
          { name: b?.name, ...(b?.shell ?? {}) },
          { prefix: '', conflicts: shellConflicts, labels: SITE_LABELS },
        ),
      }
    }
    case 'file': {
      const a = (before ?? null) as FileContent | null
      const b = (after ?? null) as FileContent | null
      const type = b?.type ?? a?.type ?? 'script'
      const binary = type === 'asset'
      return {
        kind: 'file',
        path: b?.path ?? a?.path ?? '',
        pathBefore: a && b && a.path !== b.path ? a.path : null,
        fileType: type,
        before: binary ? null : (a?.content ?? null),
        after: binary ? null : (b?.content ?? null),
        binary,
      }
    }
  }
}
