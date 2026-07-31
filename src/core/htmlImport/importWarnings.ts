/**
 * Import-time diagnostics for authored references the importer cannot verify
 * by shape alone.
 *
 * `<instatic-loop data-source-id="…">` carries a string that must name a
 * registered loop source. Nothing checked it: the id was copied verbatim into
 * props, `site_insert_html` reported success, the document persisted intact,
 * and at publish time `loopPrefetch` turned the unregistered source into a
 * well-formed `{ items: [], totalItems: 0 }` — indistinguishable from "this
 * table is empty". The section rendered as nothing, and every gate passed,
 * because the route still returned 200 with a title and an h1.
 *
 * These are warnings rather than hard failures. A paste of thirty elements
 * should not be rejected wholesale for one mistyped attribute, and the
 * importer also serves arbitrary user-pasted HTML. What matters is that the
 * caller is TOLD, at author time, instead of finding an empty section in a
 * screenshot weeks later.
 */
import { loopSourceRegistry } from '@core/loops/registry'

export interface ImportWarning {
  kind: 'unknown-loop-source' | 'loop-missing-filter'
  /** Node the warning is about, so a caller can point at it. */
  nodeId: string
  message: string
}

/**
 * Warnings for one produced node. Returns an empty array for anything that is
 * not a loop, or when no sources are registered at all — an empty registry
 * means the host simply has not imported them, and warning on every loop then
 * would be noise, not signal.
 */
export function warningsForNode(
  nodeId: string,
  moduleId: string,
  props: Record<string, unknown>,
): ImportWarning[] {
  if (moduleId !== 'base.loop') return []
  if (loopSourceRegistry.size === 0) return []

  const sourceId = typeof props.sourceId === 'string' ? props.sourceId.trim() : ''
  if (!sourceId) {
    return [{
      kind: 'unknown-loop-source',
      nodeId,
      message:
        'Loop has no data-source-id, so it will render nothing. '
        + `Valid source ids: ${knownSourceIds()}.`,
    }]
  }

  const source = loopSourceRegistry.get(sourceId)
  if (!source) {
    return [{
      kind: 'unknown-loop-source',
      nodeId,
      message:
        `Loop data-source-id "${sourceId}" is not a registered loop source, so it will `
        + `render nothing. Valid source ids: ${knownSourceIds()}. `
        + 'A table slug is not a source id — use data-source-id="data.rows" with '
        + 'data-table-id="<table>".',
    }]
  }

  // A source that declares required filters cannot resolve without them:
  // `data.rows` with no `tableId` returns an empty page exactly like an
  // unregistered source does.
  const filters = (props.filters ?? {}) as Record<string, unknown>
  const missing = requiredFilterKeys(sourceId).filter((key) => {
    const value = filters[key]
    return value === undefined || value === null || value === ''
  })
  if (missing.length > 0) {
    return [{
      kind: 'loop-missing-filter',
      nodeId,
      message:
        `Loop source "${sourceId}" needs ${missing.map((k) => `data-${kebab(k)}`).join(', ')} `
        + 'and will render nothing without it.',
    }]
  }

  return []
}

/**
 * Filters a source cannot resolve without. Declared here rather than on the
 * source because `filterSchema` describes the picker UI and marks nothing as
 * required; `data.rows` is the only source that hard-returns empty on a
 * missing filter (see `dataRows.ts`, `if (!opts.tableId) return { items: [] }`).
 */
function requiredFilterKeys(sourceId: string): string[] {
  return sourceId === 'data.rows' ? ['tableId'] : []
}

function knownSourceIds(): string {
  return loopSourceRegistry.list().map((source) => `"${source.id}"`).join(', ')
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}
