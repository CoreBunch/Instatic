/**
 * useExportEstimate — client-side bundle size estimator.
 *
 * Uses simple per-row and per-asset constants to produce a rough estimate of
 * the final bundle size. The result is a display string suitable for the
 * "Estimated size: ~127 KB" line in ExportDialog.
 *
 * Constants (deliberately conservative):
 *   - Site shell: 8 KB flat
 *   - Per row:    1.5 KB
 *   - Per media asset: 100 KB (default; configurable via `mediaPerAssetBytes`)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseExportEstimateOpts {
  /** rowCounts[tableId] = number of rows in that table. */
  rowCounts: Record<string, number>
  /** The subset of table ids currently checked in the dialog. */
  selectedTableIds: Set<string>
  /** Export scope. When 'selected', only `selectedRowIdCount` rows are costed. */
  scope: 'all' | 'selected'
  /** Number of individually selected row ids (only meaningful when scope='selected'). */
  selectedRowIdCount: number
  /** Whether to include the site shell in the estimate. */
  includeSite: boolean
  /** Whether to include media bytes in the estimate. */
  includeMedia: boolean
  /**
   * Rough per-asset byte estimate used when `includeMedia` is true.
   * Defaults to 100_000 (100 KB).
   */
  mediaPerAssetBytes?: number
  /**
   * Number of media assets in the workspace. Used when `includeMedia` is true.
   * When not supplied (or 0), media cost is 0.
   */
  mediaAssetCount?: number
}

interface UseExportEstimateResult {
  bytes: number
  formatted: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SITE_SHELL_BYTES = 8 * 1024          // 8 KB
const BYTES_PER_ROW   = 1.5 * 1024        // 1.5 KB
const DEFAULT_MEDIA_BYTES_PER_ASSET = 100_000 // 100 KB

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return '< 1 KB'
  if (bytes < 1_000_000) return `~${Math.round(bytes / 1024)} KB`
  return `~${(bytes / 1_048_576).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useExportEstimate({
  rowCounts,
  selectedTableIds,
  scope,
  selectedRowIdCount,
  includeSite,
  includeMedia,
  mediaPerAssetBytes = DEFAULT_MEDIA_BYTES_PER_ASSET,
  mediaAssetCount = 0,
}: UseExportEstimateOpts): UseExportEstimateResult {
  let bytes = 0

  // Site shell
  if (includeSite) {
    bytes += SITE_SHELL_BYTES
  }

  // Row cost
  if (scope === 'selected') {
    bytes += selectedRowIdCount * BYTES_PER_ROW
  } else {
    // Sum row counts for all selected tables
    let totalRows = 0
    for (const tableId of selectedTableIds) {
      totalRows += rowCounts[tableId] ?? 0
    }
    bytes += totalRows * BYTES_PER_ROW
  }

  // Media cost
  if (includeMedia && mediaAssetCount > 0) {
    bytes += mediaAssetCount * mediaPerAssetBytes
  }

  return { bytes, formatted: formatBytes(bytes) }
}
