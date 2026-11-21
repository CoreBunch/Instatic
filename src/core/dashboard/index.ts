/**
 * Dashboard widget core — single barrel for widget types, registry, and
 * the SDK-facing registration helper.
 */
export * from './types'
export type { PixelArtIconComponent } from './iconLookup'
export { dashboardWidgetRegistry } from './registry'
export { PublishLineupStatsSchema, type PublishLineupRow, type PublishLineupStats } from './publishLineup'
