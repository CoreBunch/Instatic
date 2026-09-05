/**
 * What the HTML panel completes beyond HTML itself: class names for the
 * `class` attribute, Visual Components for `<instatic-component>`, and the
 * dynamic-token sources with their field schemas — system sources always,
 * `currentEntry` / `parentEntry` from the entry frames in scope: the
 * template page's entry and the loops enclosing the projected root (from the
 * tree, here), plus the loops around the cursor (from the text, in the
 * editor).
 */
import type { NodeTree, Page, PageNode, SiteDocument } from '@core/page-tree'
import { getAncestors } from '@core/page-tree'
import { loopSourceRegistry } from '@core/loops/registry'
import { primaryTemplateTableSlug } from '@core/templates'
import type { DataMeta } from '@core/data/schemas'
import { SYSTEM_SOURCES } from '@admin/shared/DataBindingPicker'
import type {
  EntryFrame,
  HtmlCompletionCatalog,
  LoopSourceFields,
  TokenFieldCompletion,
} from '@site/code-editor/completionCatalog'
import { deriveClassCompletions } from './classCompletions'

export interface HtmlCompletionInputs {
  site: SiteDocument
  /** The tree the projected document lives in. */
  tree: NodeTree<PageNode>
  /** The projected root — its ancestors (not itself) are outside the document. */
  rootId: string
  /** The active page when the tree is a page tree; null in VC canvas mode. */
  activePage: Page | null
  /** Table schemas, once loaded; null until then (table fields are simply absent). */
  dataMeta: DataMeta | null
}

function pickField(field: TokenFieldCompletion): TokenFieldCompletion {
  return { id: field.id, label: field.label }
}

export function loopEntryFrame(node: PageNode): EntryFrame {
  const filters = node.props.filters
  const tableId =
    filters && typeof filters === 'object' && !Array.isArray(filters)
      ? (filters as Record<string, unknown>).tableId
      : undefined
  return {
    kind: 'loop',
    sourceId: typeof node.props.sourceId === 'string' && node.props.sourceId !== '' ? node.props.sourceId : null,
    tableId: typeof tableId === 'string' && tableId !== '' ? tableId : null,
  }
}

function outerEntries(inputs: HtmlCompletionInputs): EntryFrame[] {
  const frames: EntryFrame[] = []
  const tableSlug = inputs.activePage ? primaryTemplateTableSlug(inputs.activePage) : null
  if (tableSlug) frames.push({ kind: 'template', tableSlug })
  for (const ancestor of getAncestors(inputs.tree, inputs.rootId)) {
    if (ancestor.moduleId === 'base.loop') frames.push(loopEntryFrame(ancestor))
  }
  return frames
}

export function deriveHtmlCompletionCatalog(inputs: HtmlCompletionInputs): HtmlCompletionCatalog {
  const loopSources: Record<string, LoopSourceFields> = {}
  for (const source of loopSourceRegistry.list()) {
    loopSources[source.id] = { label: source.label, fields: source.fields.map(pickField) }
  }
  return {
    kind: 'html',
    classes: deriveClassCompletions(inputs.site, { includeGenerated: true }),
    components: inputs.site.visualComponents.map((vc) => ({ id: vc.id, name: vc.name })),
    tokens: {
      systemSources: SYSTEM_SOURCES.map((source) => ({
        id: source.id,
        label: source.label,
        fields: source.fields.map(pickField),
      })),
      loopSources,
      tables: (inputs.dataMeta?.tables ?? []).map((table) => ({
        id: table.id,
        slug: table.slug,
        name: table.name,
        kind: table.kind,
        fields: table.fields.map(pickField),
      })),
      outerEntries: outerEntries(inputs),
    },
  }
}
