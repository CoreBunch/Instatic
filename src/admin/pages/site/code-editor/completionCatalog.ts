/**
 * completionCatalog — what the God Mode panels know that a plain text editor
 * doesn't, in a CodeMirror-free shape: the site's class names, the custom
 * properties that exist on the published site, the dynamic-token sources and
 * their field schemas, and the page's real classes/ids for script selectors.
 *
 * The panels derive a catalog from editor state (`code-dock/completions/`)
 * and hand it to `CodeMirrorEditor`, whose lazy chunk turns it into
 * completion sources appended to each language's defaults
 * (`contextCompletions.ts`). Keeping the data here — no CodeMirror imports —
 * lets the derivations run and be tested in the eager graph.
 */
import type { SiteCustomProperty } from '@core/cssProjection'
import type { DataMetaTable } from '@core/data/schemas'
import type { LoopSourceField } from '@core/loops/types'
import { loopMetadataFields } from '@admin/shared/DataBindingPicker'

export interface ClassNameCompletion {
  name: string
  /** Elements the class is assigned to, site-wide. */
  usage: number
  /** A locked framework utility: assignable in HTML, never editable in CSS. */
  generated: boolean
}

export type TokenFieldCompletion = Pick<LoopSourceField, 'id' | 'label'>

export interface TokenSystemSource {
  id: 'page' | 'site' | 'route'
  label: string
  fields: TokenFieldCompletion[]
}

export interface LoopSourceFields {
  label: string
  fields: TokenFieldCompletion[]
}

export interface TableFields {
  id: string
  slug: string
  name: string
  kind: DataMetaTable['kind']
  fields: TokenFieldCompletion[]
}

/**
 * One frame of the publisher's entry stack: a loop iteration (the loop's
 * source and, for `data.rows`, its table) or a single-entry template page.
 */
export type EntryFrame =
  | { kind: 'loop'; sourceId: string | null; tableId: string | null }
  | { kind: 'template'; tableSlug: string }

export interface TokenCompletionCatalog {
  systemSources: TokenSystemSource[]
  /** Registered loop sources by id, with the fields each declares. */
  loopSources: Record<string, LoopSourceFields>
  /** Data tables the site can loop over, with their field schemas. */
  tables: TableFields[]
  /**
   * Entry frames in effect OUTSIDE the edited document, outermost first:
   * the template page's entry, then the loops enclosing the projected root.
   * Loops inside the document itself are found from its text.
   */
  outerEntries: EntryFrame[]
}

export interface HtmlCompletionCatalog {
  kind: 'html'
  classes: ClassNameCompletion[]
  /** Visual Components, for `<instatic-component data-component-id>`. */
  components: { id: string; name: string }[]
  tokens: TokenCompletionCatalog
}

export interface CssCompletionCatalog {
  kind: 'css'
  /** Editable classes only — framework utilities are locked in the CSS panel. */
  classes: ClassNameCompletion[]
  customProperties: SiteCustomProperty[]
}

export interface JsCompletionCatalog {
  kind: 'js'
  /** Every class name assigned somewhere in the page. */
  classes: string[]
  /** Every element id set in the page. */
  ids: string[]
  /** The selected element's own classes and id — offered first. */
  selectedClasses: string[]
  selectedIds: string[]
}

export type EditorCompletionCatalog = HtmlCompletionCatalog | CssCompletionCatalog | JsCompletionCatalog

const DATA_ROWS_SOURCE_ID = 'data.rows'

/** The fields a `currentEntry` exposes inside one entry frame. */
export function entryFrameFields(tokens: TokenCompletionCatalog, frame: EntryFrame): TokenFieldCompletion[] {
  if (frame.kind === 'template') {
    const table = tokens.tables.find((t) => t.slug === frame.tableSlug)
    if (!table) return []
    const rowFields = tokens.loopSources[DATA_ROWS_SOURCE_ID]?.fields ?? []
    return [...table.fields, ...loopMetadataFields(table, rowFields)]
  }
  const source = frame.sourceId ? tokens.loopSources[frame.sourceId] : undefined
  const table = frame.tableId ? tokens.tables.find((t) => t.id === frame.tableId) : undefined
  if (table) return [...table.fields, ...loopMetadataFields(table, source?.fields ?? [])]
  return source?.fields ?? []
}

export interface EntryFields {
  /** `null` when no entry is in scope — the source is not offered. */
  currentEntry: TokenFieldCompletion[] | null
  parentEntry: TokenFieldCompletion[] | null
}

/**
 * Resolve `currentEntry` / `parentEntry` for a position: the innermost frame
 * of the stack (`outerEntries` then the loops enclosing the position in the
 * document, outermost first) is the current entry, the one below it the
 * parent entry.
 */
export function resolveEntryFields(tokens: TokenCompletionCatalog, innerFrames: readonly EntryFrame[]): EntryFields {
  const stack = [...tokens.outerEntries, ...innerFrames]
  const current = stack[stack.length - 1]
  const parent = stack[stack.length - 2]
  return {
    currentEntry: current ? entryFrameFields(tokens, current) : null,
    parentEntry: parent ? entryFrameFields(tokens, parent) : null,
  }
}
