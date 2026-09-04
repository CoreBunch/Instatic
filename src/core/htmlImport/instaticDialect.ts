/**
 * The instatic-* dialect's attribute vocabulary — the import side of the
 * loop/outlet marker tags, shared by the rule table (full default-bag
 * mapping for new nodes) and the uid-preserving projection importer
 * (attribute-presence patching for matched nodes).
 *
 * The vocabulary must stay the exact inverse of the projection emit
 * (`renderProjectionLoop` / `renderProjectionOutlet` in
 * `src/core/publisher/renderProjection.ts`): what the projection emits is
 * what these functions accept.
 */

import { attr, normalizedAttr, integerAttr } from './attrReaders'

/** Full default prop bag for a NEW `base.loop` node from an `<instatic-loop>`. */
export function mapLoopProps(el: Element): Record<string, unknown> {
  const tableId = attr(el, 'data-table-id')
  const customTag = attr(el, 'data-custom-tag')
  const tag = attr(el, 'data-tag')
  return {
    sourceId: attr(el, 'data-source-id'),
    filters: tableId ? { tableId } : {},
    orderBy: attr(el, 'data-order-by'),
    direction: normalizedAttr(el, 'data-direction') === 'asc' ? 'asc' : 'desc',
    limit: integerAttr(el, 'data-limit', 10, 1),
    offset: integerAttr(el, 'data-offset', 0, 0),
    pagination: normalizedAttr(el, 'data-pagination') === 'infinite' ? 'infinite' : 'none',
    pageSize: integerAttr(el, 'data-page-size', 10, 1),
    ...(customTag ? { tag: 'custom', customTag } : tag ? { tag } : {}),
  }
}

/** Tag props for a `base.outlet` from an `<instatic-outlet>` (partial by design). */
export function mapOutletProps(el: Element): Record<string, unknown> {
  const customTag = attr(el, 'data-custom-tag')
  const tag = attr(el, 'data-tag')
  return customTag
    ? { tag: 'custom', customTag }
    : tag
      ? { tag }
      : {}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Uid-preserving patch for a matched `base.loop` node (the projection
 * importer's counterpart to `mapLoopProps`, which builds a FULL default bag
 * and therefore cannot patch).
 *
 * The projection emits an attribute only when the corresponding prop would
 * render it (`renderProjectionLoop`), so this reads attributes back with the
 * same asymmetry: a present attribute sets the prop; an absent attribute
 * resets the prop to the dialect's empty value ONLY when the prop exists and
 * would have been emitted (the author deleted the attribute), and leaves
 * everything else untouched.
 *
 * `filters` is the critical partial view: the projection emits only
 * `filters.tableId` (as `data-table-id`) from the free-form filter bag, so
 * this sets/clears `tableId` and preserves every other (plugin-defined)
 * filter key — it never rebuilds `filters` wholesale from attributes.
 */
export function patchLoopProps(
  el: Element,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing }

  const patchString = (key: string, name: string) => {
    if (el.hasAttribute(name)) next[key] = attr(el, name)
    else if (key in next) next[key] = ''
  }
  patchString('sourceId', 'data-source-id')
  patchString('orderBy', 'data-order-by')

  if (el.hasAttribute('data-direction')) {
    next.direction = normalizedAttr(el, 'data-direction') === 'asc' ? 'asc' : 'desc'
  }
  if (el.hasAttribute('data-limit')) next.limit = integerAttr(el, 'data-limit', 10, 1)
  else if ('limit' in next) next.limit = 10
  if (el.hasAttribute('data-offset')) next.offset = integerAttr(el, 'data-offset', 0, 0)
  else if ('offset' in next) next.offset = 0

  if (normalizedAttr(el, 'data-pagination') === 'infinite') {
    next.pagination = 'infinite'
    next.pageSize = integerAttr(el, 'data-page-size', 10, 1)
  } else if ('pagination' in next) {
    // data-page-size is only projected in infinite mode, so a stored pageSize
    // is left untouched here — its absence is not author intent.
    next.pagination = 'none'
  }

  const filters = isPlainRecord(existing.filters) ? { ...existing.filters } : {}
  if (el.hasAttribute('data-table-id')) {
    filters.tableId = attr(el, 'data-table-id')
  } else if (filters.tableId !== undefined && filters.tableId !== '') {
    // The attribute would have been emitted for this value — the author
    // removed it. (An empty-string tableId never projects, so it survives.)
    delete filters.tableId
  }
  next.filters = filters

  const customTag = attr(el, 'data-custom-tag')
  const tag = attr(el, 'data-tag')
  if (customTag) {
    next.tag = 'custom'
    next.customTag = customTag
  } else if (tag) {
    next.tag = tag
  }

  return next
}
