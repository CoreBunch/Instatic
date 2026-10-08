/**
 * useLoopPreviewItems — fetches real iteration data for a `base.loop`
 * node so the editor canvas previews bound dynamic content with real
 * entries instead of placeholder strings.
 *
 * Mirrors the publisher's `prefetchLoopData()` semantics on the canvas
 * side: filters → orderBy → direction → offset → limit. Every change to
 * any of those properties re-runs the pipeline so the preview stays in
 * sync with what the published page will emit.
 *
 * Built-in source dispatch table:
 *   - `data.rows`  — fetches real published rows via the admin endpoint
 *     `GET /data/tables/:id/loop-preview`, which runs the same
 *     `fetchPublishedDataRowItems` projection the publisher uses, with the
 *     canonical page language. Empty sources have no real iterations.
 *   - `site.pages` — reads pages from the in-memory site document,
 *     filters / sorts / offsets / limits client-side.
 *   - `site.media` — fetches via `listCmsMediaAssets()`, filters by
 *     mime prefix, sorts + offsets + limits client-side.
 *   - any other source — falls back to the source's synchronous
 *     `preview()` method (plugin sources can ship synthetic data;
 *     follow-up work will let plugins declare a server fetch endpoint).
 *
 * Subscription granularity: the hook never subscribes to the whole `site`
 * document for built-in sources. `site.pages` loops subscribe through
 * `selectSitePagesLoopItems`, whose output keeps a stable identity (per-page
 * WeakMap projection cache + previous-array reuse) when an unrelated edit
 * replaces the `pages` array without changing the loop's actual items — so
 * typing in an unrelated text node no longer re-renders every loop body
 * subtree in every breakpoint frame. Only the plugin-source fallback (whose
 * `preview()` contractually receives the full document) subscribes to
 * `site`, and only when such a source is selected.
 */

import { use, useEffect } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'
import { loopSourceRegistry } from '@core/loops/registry'
import {
  ENTRY_FIELD_FILTER_KEY,
  ENTRY_FIELD_SOURCE_ID,
  filterPagesForLoop,
  pageToLoopItem,
  resolveEntryFieldItems,
  type EntryFieldMedia,
  type LoopItem,
} from '@core/loops'
import type { Page, PageNode } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { getCmsDataTable, previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { listCmsMediaAssets, type CmsMediaAsset } from '@core/persistence/cmsMedia'
import { CanvasPreviewReadinessContext } from './CanvasPreviewReadiness'

// ---------------------------------------------------------------------------
// Loop prop reader
// ---------------------------------------------------------------------------

interface ResolvedLoopProps {
  sourceId: string
  filters: Record<string, unknown>
  orderBy: string
  direction: 'asc' | 'desc'
  offset: number
  /** Canvas-side limit, capped for performance. */
  limit: number
}

/**
 * Cap canvas preview at a handful of iterations — alternating layouts and
 * grid patterns only need a few items to be visible. Loops with `limit`
 * > CANVAS_MAX still publish their full set; the cap is editor-canvas only.
 */
const CANVAS_MAX_ITEMS = 6

// Shared sentinel for "no filters configured" — keeps identity stable across
// renders so downstream memos that depend on `filters` don't re-run when the
// node simply has no filters set. Treated as read-only at every call site.
const EMPTY_FILTERS: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>

function readLoopProps(node: PageNode): ResolvedLoopProps {
  const props = node.props
  const sourceId = typeof props.sourceId === 'string' ? props.sourceId : ''
  const filters =
    props.filters && typeof props.filters === 'object' && !Array.isArray(props.filters)
      ? (props.filters as Record<string, unknown>)
      : EMPTY_FILTERS
  const orderBy = typeof props.orderBy === 'string' ? props.orderBy : ''
  const direction = props.direction === 'asc' ? 'asc' : 'desc'
  const rawLimit = typeof props.limit === 'number' ? Math.floor(props.limit) : 3
  const limit = Math.min(Math.max(rawLimit, 1), CANVAS_MAX_ITEMS)
  const rawOffset = typeof props.offset === 'number' ? Math.floor(props.offset) : 0
  const offset = Math.max(rawOffset, 0)
  return { sourceId, filters, orderBy, direction, offset, limit }
}

// ---------------------------------------------------------------------------
// Comparators — mirror the server-side ordering used in each source's fetch()
// ---------------------------------------------------------------------------

function dateMs(value: string | null | undefined): number {
  const ts = Date.parse(value ?? '')
  return Number.isFinite(ts) ? ts : 0
}

function applyDirection<T>(cmp: (a: T, b: T) => number, direction: 'asc' | 'desc') {
  return direction === 'asc' ? cmp : (a: T, b: T) => -cmp(a, b)
}

function sortPages(pages: Page[], orderBy: string, direction: 'asc' | 'desc'): Page[] {
  const out = [...pages]
  if (orderBy === 'title') {
    out.sort(applyDirection((a, b) => a.title.localeCompare(b.title), direction))
  } else if (orderBy === 'slug') {
    out.sort(applyDirection((a, b) => a.slug.localeCompare(b.slug), direction))
  } else {
    // 'definition' (or empty) — preserve site.pages order; descending reverses.
    if (direction === 'desc') out.reverse()
  }
  return out
}

function sortMedia(
  assets: CmsMediaAsset[],
  orderBy: string,
  direction: 'asc' | 'desc',
): CmsMediaAsset[] {
  const out = [...assets]
  let cmp: (a: CmsMediaAsset, b: CmsMediaAsset) => number
  if (orderBy === 'filename') {
    cmp = (a, b) => a.filename.localeCompare(b.filename)
  } else {
    cmp = (a, b) => dateMs(a.createdAt) - dateMs(b.createdAt)
  }
  out.sort(applyDirection(cmp, direction))
  return out
}

function mediaAssetToLoopItem(asset: CmsMediaAsset): LoopItem {
  return {
    id: asset.id,
    fields: {
      id: asset.id,
      filename: asset.filename,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      path: asset.publicPath,
      url: asset.publicPath,
      src: asset.publicPath,
      uploadedByUserId: asset.uploadedByUserId,
      uploadedById: asset.uploadedByUserId,
      createdAt: asset.createdAt,
    },
  }
}

// `pageToLoopItem` and `filterPagesForLoop` are imported from `@core/loops`
// so the canvas preview consumes the engine's loop-item projection rather
// than re-deriving it — keeping editor previews and published output in sync.

// ---------------------------------------------------------------------------
// site.pages selection — identity-stable across unrelated site mutations
// ---------------------------------------------------------------------------

/** Stable empty result shared by every inactive branch of the selectors. */
const EMPTY_ITEMS: LoopItem[] = []

// page → LoopItem projection cache. Mutative structural sharing keeps
// untouched page objects identical across site mutations, so the projected
// item keeps its identity too — which is what lets the items-array reuse
// below actually hit.
const pageLoopItemCache = new WeakMap<Page, LoopItem>()

function cachedPageToLoopItem(page: Page): LoopItem {
  let item = pageLoopItemCache.get(page)
  if (!item) {
    item = pageToLoopItem(page)
    pageLoopItemCache.set(page, item)
  }
  return item
}

interface SitePagesItemsCacheEntry {
  pages: readonly Page[]
  items: LoopItem[]
}

// Per-loop-node result cache, keyed on the node object. The node keeps its
// identity until ITS OWN props change (structural sharing again), so the
// entry self-invalidates on filter/order/limit edits; the `pages` field
// detects site mutations. Shared across the 3 breakpoint frames rendering
// the same node — frames 2..N hit the first frame's entry.
const sitePagesItemsCache = new WeakMap<PageNode, SitePagesItemsCacheEntry>()

function sameItems(a: readonly LoopItem[], b: readonly LoopItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Project `pages` into the loop items for a `site.pages`-bound loop node,
 * keeping the result referentially stable:
 *
 *  - same (node, pages) identities → cached array, no recompute;
 *  - new `pages` identity whose relevant pages are untouched → recomputes,
 *    then returns the PREVIOUS array because every member is identical.
 *
 * Runs inside a Zustand selector on every store set, so the steady-state
 * path is two identity checks; the recompute path is O(pages log pages).
 */
export function selectSitePagesLoopItems(node: PageNode, pages: readonly Page[] | null): LoopItem[] {
  if (!pages) return EMPTY_ITEMS

  const cached = sitePagesItemsCache.get(node)
  if (cached && cached.pages === pages) return cached.items

  const { filters, orderBy, direction, offset, limit } = readLoopProps(node)
  const filtered = filterPagesForLoop(pages, filters)
  const sorted = sortPages(filtered, orderBy || 'definition', direction)
  let items = sorted.slice(offset, offset + limit).map(cachedPageToLoopItem)
  if (cached && sameItems(cached.items, items)) items = cached.items

  sitePagesItemsCache.set(node, { pages, items })
  return items
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const BUILT_IN_SOURCE_IDS = new Set([
  'data.rows',
  'site.media',
  'site.pages',
  ENTRY_FIELD_SOURCE_ID,
])

export function useLoopPreviewItems(
  node: PageNode,
  templateContext?: TemplateRenderDataContext,
): { items: LoopItem[]; error: string | null; loading: boolean; refresh: () => void } {
  const previewReadiness = use(CanvasPreviewReadinessContext)
  // `readLoopProps()` reuses the shared `EMPTY_FILTERS` sentinel when the
  // node has no filters set, so `filters` identity is stable across renders
  // for the no-filter case. When filters ARE set, the value comes straight
  // from `node.props.filters`, which the editor store (Zustand + Mutative)
  // keeps referentially stable until the user actually edits it. Either way
  // the downstream memo can depend on `filters` directly without thrashing.
  const { sourceId, filters, orderBy, direction, offset, limit } = readLoopProps(node)
  const tableId = typeof filters.tableId === 'string' ? filters.tableId : ''
  const mimePrefix = typeof filters.mimePrefix === 'string' ? filters.mimePrefix : ''
  // Read as primitives so the fetch effect's dependency list stays stable.
  const cellField = typeof filters.cellField === 'string' ? filters.cellField : ''
  const cellOperator = typeof filters.cellOperator === 'string' ? filters.cellOperator : ''
  const cellValue = typeof filters.cellValue === 'string' ? filters.cellValue : ''
  const language = templateContext?.site?.language
  const isPluginSource = sourceId !== '' && !BUILT_IN_SOURCE_IDS.has(sourceId)

  // Narrow, identity-stable subscriptions (see module header). Inactive
  // branches resolve to stable constants so the subscription never fires
  // for them.
  const sitePagesItems = useEditorStore((s) =>
    sourceId === 'site.pages' ? selectSitePagesLoopItems(node, s.site?.pages ?? null) : EMPTY_ITEMS,
  )
  // Plugin `preview()` contractually receives the whole site document, so
  // this is the one branch that genuinely depends on it.
  const pluginSite = useEditorStore((s) => (isPluginSource ? s.site : null))

  // Schema and rows are one logical preview; a failure never becomes a
  // successful empty collection or representative localized text.
  const dataRequestKey = JSON.stringify([sourceId, tableId, orderBy, direction, limit, offset, cellField, cellOperator, cellValue, language])
  const dataResource = useAsyncResource(async () => {
    if (sourceId !== 'data.rows' || !tableId) return null
    const request = Promise.all([getCmsDataTable(tableId), previewCmsDataLoopItems(tableId, {
      orderBy: orderBy || 'publishedAt', direction, limit, offset, cellField, cellOperator, cellValue, language,
    })])
    previewReadiness?.track(request)
    const [table, result] = await request
    if (!table) throw new Error('The loop data table was not found')
    return { key: dataRequestKey, table, items: result.items }
  }, [dataRequestKey, previewReadiness])
  const readsMedia = sourceId === 'site.media' || sourceId === ENTRY_FIELD_SOURCE_ID
  const mediaResource = useAsyncResource(async () => {
    if (!readsMedia) return null
    const request = listCmsMediaAssets()
    previewReadiness?.track(request)
    return await request
  }, [readsMedia, previewReadiness])
  const asyncMedia = readsMedia && !mediaResource.error ? mediaResource.data ?? [] : []
  const pluginRequestKey = JSON.stringify([sourceId, filters, limit, offset])
  const pluginResource = useAsyncResource(async () => {
    if (!isPluginSource || !pluginSite) return null
    const source = loopSourceRegistry.get(sourceId)
    if (!source) throw new Error('The loop data source was not found')
    if (source.kind === 'contextual') return null
    return { key: pluginRequestKey, items: source.preview({ site: pluginSite, filters, limit }).slice(offset, offset + limit) }
  }, [isPluginSource, pluginSite, pluginRequestKey])
  const resourceError = sourceId === 'data.rows' ? dataResource.error : readsMedia ? mediaResource.error : isPluginSource ? pluginResource.error : null
  const refresh = sourceId === 'data.rows' ? dataResource.refresh : readsMedia ? mediaResource.refresh : pluginResource.refresh
  useEffect(() => {
    if (resourceError) pushToast({ kind: 'error', title: 'Could not preview loop data', body: resourceError,
      action: { label: 'Retry', onSelect: refresh } })
  }, [resourceError, refresh])

  // ── Sort + offset + limit pipeline ──────────────────────────────────
  const items = (() => {
    if (!sourceId) return EMPTY_ITEMS

    if (sourceId === 'data.rows') {
      const data = dataResource.data?.key === dataRequestKey && !dataResource.error ? dataResource.data : null
      if (!data) return EMPTY_ITEMS
      return data.items
    }

    if (sourceId === 'site.media') {
      if (asyncMedia.length === 0) return EMPTY_ITEMS
      const filtered = mimePrefix
        ? asyncMedia.filter((a) => a.mimeType.startsWith(mimePrefix))
        : asyncMedia
      const sorted = sortMedia(filtered, orderBy || 'createdAt', direction)
      return sorted.slice(offset, offset + limit).map(mediaAssetToLoopItem)
    }

    if (sourceId === ENTRY_FIELD_SOURCE_ID) {
      const fieldId = filters[ENTRY_FIELD_FILTER_KEY]
      if (typeof fieldId !== 'string' || !fieldId) return EMPTY_ITEMS
      const stack = templateContext?.entryStack ?? []
      const entry = stack[stack.length - 1]
      const mediaByReference = new Map<string, EntryFieldMedia>()
      for (const asset of asyncMedia) {
        mediaByReference.set(asset.id, asset)
        mediaByReference.set(asset.publicPath, asset)
      }
      return resolveEntryFieldItems(entry?.fields[fieldId], {
        offset,
        limit,
        direction,
        mediaByReference,
      }).items
    }

    if (sourceId === 'site.pages') return sitePagesItems

    return pluginResource.data?.key === pluginRequestKey && !pluginResource.error ? pluginResource.data.items : EMPTY_ITEMS
  })()
  return { items, error: resourceError, loading: sourceId === 'data.rows' ? dataResource.loading : readsMedia ? mediaResource.loading : isPluginSource && pluginResource.loading, refresh }
}
