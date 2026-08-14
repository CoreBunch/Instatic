/**
 * Render-time data context shared by structured dynamic bindings and inline
 * token interpolation.
 */

import type { LoopItem } from '@core/loops/types'
import type {
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
  /** Published custom-data rows keyed by immutable row id. */
  readonly data?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}
