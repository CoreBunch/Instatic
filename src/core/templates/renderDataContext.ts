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
 * Render-time context handed to the publisher.
 *
 * `entryStack` is an immutable snapshot for the current frame. Stack-top
 * resolves `currentEntry`; one below resolves `parentEntry`. The named frames
 * are built by the publisher and referenced by their matching binding sources.
 */
export interface TemplateRenderDataContext {
  readonly entryStack: readonly LoopItem[]
  readonly page?: PageFrame
  readonly site?: SiteFrame
  readonly route?: RouteFrame
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
