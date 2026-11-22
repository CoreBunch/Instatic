/**
 * commitThemePlan — carry out a theme plan, on the same machinery as a
 * fragment insert (`commitFragmentPlan`):
 *
 *   A. Media: reuse a library asset that is the same file, else upload.
 *   B. Fonts: install Google families, register custom ones from the uploads.
 *   C. Resolve the plan against what A and B produced.
 *   D. ONE store transaction (`adapter.commit`): one undo step.
 *
 * A media upload that fails throws `FragmentCommitError` (stage `media`)
 * before D, so nothing touches the site; files already uploaded stay in the
 * media library. A font that fails to install is a warning (a rebound token
 * keeps its family, an added one falls back to its stack). Cancellation
 * (`signal`) stops at the next boundary and never after D has started.
 */

import { installFonts, resolveMedia, type CommitFragmentPlanOptions } from './commit'
import { resolveThemePlan } from './applyTheme'
import type { ThemeApplyAdapter } from './adapter'
import type { ThemeApplyPlan, ThemeApplyReport } from './planTheme'
import type { FragmentWarning } from './warnings'

export interface ThemeApplyResult {
  report: ThemeApplyReport
}

export async function commitThemePlan(
  plan: ThemeApplyPlan,
  adapter: ThemeApplyAdapter,
  options: CommitFragmentPlanOptions,
): Promise<ThemeApplyResult> {
  const warnings: FragmentWarning[] = []
  const media = await resolveMedia(plan.media, adapter, options)
  const fontEntryByFamilyId = await installFonts(plan.fontFamilies, media.idById, adapter, options, warnings)
  const resolved = resolveThemePlan(plan, { mediaUrlByPath: media.urlByPath, fontEntryByFamilyId })

  options.signal?.throwIfAborted()
  options.onProgress?.({ phase: 'commit', done: 0, total: 1 })
  await adapter.commit(resolved)

  return {
    report: {
      ...plan.report,
      media: { total: plan.media.length, uploaded: media.uploaded, reused: media.reused },
      warnings: [...plan.report.warnings, ...warnings],
    },
  }
}
