/**
 * Render-time data context shared by structured dynamic bindings and inline
 * token interpolation.
 */

import type { ApprovalView } from '@core/members'
import type { LoopItem } from '@core/loops/types'
import type {
  MemberFrame,
  PageFrame,
  RouteFrame,
  SiteFrame,
} from './contextFrames'

/**
 * Minimal media-asset shape the binding resolver needs to translate a stored
 * asset reference into a served URL. The publisher's `RenderResolvedMedia`,
 * the server repo's `MediaAsset`, and the admin's `CmsMediaAsset` all satisfy
 * it structurally, so every surface can hand its own map straight in.
 */
export interface TemplateMediaAsset {
  readonly publicPath: string
}

/**
 * Render-time context handed to the publisher.
 *
 * `entryStack` is an immutable snapshot for the current frame. Stack-top
 * resolves `currentEntry`; one below resolves `parentEntry`. The named frames
 * are built by the publisher and referenced by their matching binding sources.
 *
 * `media` is a live in-memory lookup keyed by asset id AND public path, used
 * by `format: 'media'` bindings to translate a bare asset reference (a custom
 * media cell stores the id) into the asset's served URL. Each surface attaches
 * its own: the publisher wires in the `prefetchMediaAssets` map, the canvas
 * wires in the admin media-library cache. Being a Map, it can never travel a
 * JSON boundary — the runtime-preview endpoint strips whatever arrived on the
 * wire and lets the server-side prefetch supply it instead.
 */
export interface TemplateRenderDataContext {
  readonly entryStack: readonly LoopItem[]
  readonly page?: PageFrame
  readonly site?: SiteFrame
  readonly route?: RouteFrame
  readonly media?: ReadonlyMap<string, TemplateMediaAsset>
  /**
   * The visitor this render is for. A frame is a signed-in member, `null` is
   * a signed-out visitor, and `undefined` means the render is for nobody in
   * particular (a baked page, a shared-cache render, the editor): member
   * bindings then resolve empty, show-when treats the visitor as signed out,
   * and the publisher defers anything member-dependent to a per-visitor hole.
   */
  readonly approval?: ApprovalView
  readonly member?: MemberFrame | null
}
