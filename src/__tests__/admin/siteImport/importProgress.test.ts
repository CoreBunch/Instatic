/**
 * Run-progress reconciliation for the Import step (#412).
 *
 * The done-state media count has to keep the PLANNED total: a run that set out
 * to upload 30 files and managed 22 finished 22 of 30, not 22 of 22.
 */

import { describe, it, expect } from 'bun:test'
import {
  makeStaticRunDoneProgress,
  makeStaticRunProgress,
} from '@admin/modals/SiteImport/shared/importProgress'
import type { ImportPlan, ImportResult } from '@core/siteImport'

function planWithAssets(count: number): ImportPlan {
  return {
    pages: [],
    styleRules: [],
    styleRuleSources: [],
    fonts: [],
    googleFonts: [],
    fontTokens: [],
    conditions: [],
    assets: Array.from({ length: count }, (_, i) => ({
      sourcePath: `images/${i}.png`,
      mimeType: 'image/png',
      bytes: new Uint8Array([1]),
    })),
    colors: [],
    scripts: [],
    linkedStylesheets: [],
    stylesheets: [],
    conflicts: { pages: [], rules: [], tokens: [], crossSheetClasses: [] },
    warnings: [],
    droppedAtRules: [],
    unusedCss: [],
  }
}

function resultWithAssets(count: number): ImportResult {
  return {
    pages: [],
    styleRules: [],
    fonts: [],
    assets: Array.from({ length: count }, (_, i) => ({
      sourcePath: `images/${i}.png`,
      mediaUrl: `/uploads/${i}.png`,
    })),
    colors: [],
    fontTokens: [],
    scripts: [],
    stylesheets: [],
    conflicts: { pages: [], rules: [], tokens: [], crossSheetClasses: [] },
    warnings: [],
  }
}

describe('makeStaticRunDoneProgress', () => {
  it('keeps the planned media total when some uploads failed', () => {
    const progress = makeStaticRunDoneProgress(planWithAssets(30), resultWithAssets(22))
    expect(progress.phase).toBe('done')
    expect(progress.categories.media).toEqual({ done: 22, total: 30 })
  })

  it('reports a clean run as N of N', () => {
    const progress = makeStaticRunDoneProgress(planWithAssets(3), resultWithAssets(3))
    expect(progress.categories.media).toEqual({ done: 3, total: 3 })
  })

  it('starts the upload phase from the same planned total', () => {
    expect(makeStaticRunProgress(planWithAssets(30)).categories.media).toEqual({ done: 0, total: 30 })
  })
})
