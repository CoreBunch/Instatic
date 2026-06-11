/**
 * Publisher — render config, accumulators, and the value types they carry.
 *
 * Every recursive call into a renderer is threaded with TWO explicit shapes,
 * separating roles that used to be conflated in a single god-object:
 *
 *  - `RenderConfig` (read-only): the inputs of a render pass — page, site,
 *    registry, breakpoint, template context, pre-fetched I/O (loop data,
 *    media assets), and the static classification / annotation flags. Every
 *    field is `readonly`; collections are `ReadonlyMap` / `ReadonlySet`. A
 *    renderer that needs a different page or template frame (VC ref, loop
 *    iteration) constructs a NEW child config — it never mutates the one it
 *    received.
 *
 *  - `RenderAccumulators` (mutable): the outputs of a render pass — the
 *    deduped CSS map, the set of infinite-loop ids, and the set of nodes that
 *    actually emitted a `<instatic-hole>`. The top-level `publishPage` owns
 *    these, initialises all three up-front, and threads the SAME instances
 *    down the whole tree so every renderer appends to one shared accumulator.
 *    Passing it as an explicit parameter is what makes the shared-mutable
 *    output visible at each call site.
 *
 * Pulling the shapes into their own file lets the standard renderer
 * (`renderNode.ts`), the specialised renderers (`renderVisualComponentRef.ts`,
 * `renderLoop.ts`), and the page orchestrator (`render.ts`) all import the
 * same types without circular dependencies.
 */

import type { Page, SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import type { LoopFetchResult } from '@core/loops/types'

/**
 * Resolved loop data for one `base.loop` node, produced by the server's
 * `prefetchLoopData()` helper before publishing.
 */
export interface ResolvedLoopRenderData extends LoopFetchResult {
  /** 1-indexed page number when the loop is in `infinite` mode. */
  pageNumber: number
  /** Whether more rows remain past the current page. */
  hasMore: boolean
}

/**
 * Resolved media-asset payload attached to a prop at render time. The pure
 * render function reads `props._resolvedMediaByKey[<propKey>]` to get the
 * variant ladder / BlurHash / intrinsic dimensions for any of its
 * image/media-typed props, and uses it to emit responsive markup. Falls
 * back to the raw prop string when undefined, so non-CMS URLs or pages
 * built before `prefetchMediaAssets` ran still render correctly.
 */
export interface RenderResolvedMedia {
  publicPath: string
  mimeType: string
  width: number | null
  height: number | null
  altText: string
  blurHash: string | null
  variants: ReadonlyArray<{
    width: number
    height: number
    format: 'webp' | 'jpeg' | 'png' | 'avif'
    path: string
    sizeBytes: number
  }>
  posterPath: string | null
}

/**
 * Read-only inputs of a render pass. A renderer trusts every field and never
 * mutates it; to render with a different page (VC ref) or a different template
 * frame (loop iteration) it builds a NEW config via `{ ...config, page }` and
 * passes that down.
 */
export interface RenderConfig {
  readonly page: Page
  readonly site: SiteDocument
  readonly registry: IModuleRegistry
  readonly breakpointId: string | undefined
  readonly templateContext?: TemplateRenderDataContext
  /**
   * Pre-fetched media assets, keyed by `public_path`. Populated by
   * `server/publish/mediaPrefetch.ts` before `publishPage()` is called.
   * Used to enrich image / media props with srcset, sizes, BlurHash, and
   * intrinsic dimensions before each module's `render()` runs.
   */
  readonly mediaAssets?: ReadonlyMap<string, RenderResolvedMedia>
  /**
   * Pre-fetched loop data, keyed by loop nodeId. Populated by
   * `server/publish/loopPrefetch.ts` before `publishPage()` is called.
   * Loops without an entry here render empty.
   */
  readonly loopData?: ReadonlyMap<string, ResolvedLoopRenderData>
  /**
   * Set of page node ids classified as dynamic by `findDynamicNodeIds`.
   * When a node's id is in this set, `renderNode` emits a `<instatic-hole>`
   * placeholder instead of recursing into the subtree. Absent (or empty)
   * means render everything inline — used by the hole endpoint and tests
   * that want full rendering without any holes.
   */
  readonly dynamicNodeIds?: ReadonlySet<string>
  /**
   * Monotonic publish version stamped into every `<instatic-hole data-instatic-version>`
   * attribute. The hole runtime sends this value back as `?v=` on each
   * fetch; the hole endpoint returns a stale fragment when the version
   * no longer matches the current `publishVersion` in `publishState.ts`.
   * Defaults to `0` when not provided (holes will immediately receive
   * a stale response on the first request after a publish, which is
   * safe — the next page load picks up the new version).
   */
  readonly publishVersion?: number
  /**
   * Editor-only annotation flag. When true, each node's outermost emitted
   * element gets a `uid="<id>"` attribute so the rendered HTML can be
   * traced back to the page tree. Default (absent/false) leaves published
   * output untouched — the clean-HTML product rule holds for every real publish.
   * Used by the agent read-surface (read_page).
   */
  readonly annotateNodeIds?: boolean
}

/**
 * Mutable outputs of a render pass. `publishPage` initialises all of them
 * up-front and threads the SAME instances down the whole tree; every renderer
 * appends to them. The container references are `readonly` (never swapped),
 * but their contents are mutated on purpose — that is the entire point of an
 * accumulator. Because this is a distinct, explicitly-passed parameter, the
 * shared-mutable output is visible at every call site instead of smuggled
 * through a cloned context.
 */
export interface RenderAccumulators {
  /**
   * CSS deduplication map: moduleId → CSS string.
   * Each module type contributes at most one CSS entry regardless of instance count.
   * Decision #308: keying by moduleId is O(1); at 200 nodes saves ~60–80% CSS vs naive concat.
   */
  readonly cssMap: Map<string, string>
  /**
   * JS deduplication map: moduleId → module runtime JS. Mirrors `cssMap` —
   * each module type contributes at most one entry regardless of instance
   * count. Served as external per-module files (never inlined), so no
   * `</script>` sanitisation is applied on store.
   */
  readonly jsMap: Map<string, string>
  /**
   * Set of loop nodeIds on the page that requested the infinite-scroll
   * runtime. The publisher reads `.size` after rendering to decide whether
   * to inject the `loop-runtime.js` `<script>` tag.
   */
  readonly infiniteLoopIds: Set<string>
  /**
   * Each node that actually emits a `<instatic-hole>` during the render walk
   * calls `acc.holeNodeIds.add(nodeId)`. After the walk completes, `render.ts`
   * reads `.size > 0` to decide whether to inject the
   * `/_instatic/hole-runtime.js` script tag into the `<head>`. This is more
   * precise than checking `dynamicNodeIds.size` because it reflects what was
   * actually rendered (not just what was classified as dynamic before the walk
   * began).
   */
  readonly holeNodeIds: Set<string>
}

/**
 * The recursive render callback. Specialised renderers receive this as a
 * parameter (rather than importing `renderNode` directly) so the file graph
 * stays acyclic — only `renderNode.ts` knows both ends of the recursion.
 */
export type RenderNodeFn = (
  nodeId: string,
  config: RenderConfig,
  acc: RenderAccumulators,
) => string
