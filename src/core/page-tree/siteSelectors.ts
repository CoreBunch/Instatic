/**
 * Site-document-level selectors with index-map memoisation.
 *
 * Visual-component refs are resolved repeatedly while publishing and while
 * detecting dynamic subtrees. This builds a `vcId → VisualComponent` map once
 * per `site.visualComponents` array reference and caches it in a module-level
 * WeakMap. Mutative gives a fresh array reference when entries mutate, so the
 * cache invalidates when the data changes.
 */
import type { SiteDocument } from './siteDocument'
import type { VisualComponent } from '@core/visual-components-schema'

// ---------------------------------------------------------------------------
// Internal caches
// ---------------------------------------------------------------------------

const _vcsByIdCache = new WeakMap<readonly VisualComponent[], Map<string, VisualComponent>>()

function buildIndex<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    map.set(item.id, item)
  }
  return map
}

const EMPTY_VC_MAP: ReadonlyMap<string, VisualComponent> = new Map()

/**
 * Return a `Map<vcId, VisualComponent>` for the given site. Memoised on the
 * `site.visualComponents` array reference. When the site has no VCs
 * (undefined array), returns a shared empty map — callers can `.get()`
 * without a null check.
 */
function selectVisualComponentsById(
  site: SiteDocument,
): ReadonlyMap<string, VisualComponent> {
  const vcs = site.visualComponents
  if (!vcs) return EMPTY_VC_MAP
  const cached = _vcsByIdCache.get(vcs)
  if (cached) return cached
  const map = buildIndex(vcs)
  _vcsByIdCache.set(vcs, map)
  return map
}

/** Lookup a single visual component by id. O(1) after the first call. */
export function selectVisualComponentById(
  site: SiteDocument,
  componentId: string,
): VisualComponent | undefined {
  return selectVisualComponentsById(site).get(componentId)
}
