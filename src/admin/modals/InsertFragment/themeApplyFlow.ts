/**
 * The editor's theme flow, beside the fragment insert flow: plan a theme
 * against the open site, run the commit (media, fonts, then ONE store
 * transaction through `applyTheme`), and announce the result. The plugin API
 * (`api.editor.fragments.planTheme` / `.applyTheme`, `pluginFragmentsHost.ts`)
 * goes through these functions.
 */

import {
  commitThemePlan,
  planThemeApply,
  type CommitFragmentPlanOptions,
  type SiteTheme,
  type ThemeApplyPlan,
  type ThemeApplyResult,
} from '@core/fragments'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'
import { createThemeApplyAdapter } from './createFragmentInsertAdapter'
import { isFragmentCommitCancel } from './fragmentInsertFlow'

type RunStepUp = <T>(action: () => Promise<T>) => Promise<T>

/** Plan a theme against the open site. */
export function planThemeForEditor(theme: SiteTheme): ThemeApplyPlan {
  const site = useEditorStore.getState().site
  if (!site) throw new Error('The site is still loading.')
  return planThemeApply({ site }, theme)
}

export interface CommitThemeRequest extends CommitFragmentPlanOptions {
  /** The admin shell's step-up runner: uploads may need a recent password. */
  runStepUp: RunStepUp
  assertCurrentTarget(): void
}

/** Media, fonts, then ONE store transaction. */
export function commitThemeForEditor(
  plan: ThemeApplyPlan,
  { runStepUp, assertCurrentTarget, ...options }: CommitThemeRequest,
): Promise<ThemeApplyResult> {
  return commitThemePlan(plan, createThemeApplyAdapter(runStepUp, assertCurrentTarget), options)
}

/** The result toast after a theme is applied. */
export function toastThemeApplied(result: ThemeApplyResult): void {
  const notes = result.report.warnings.length
  pushToast({
    kind: notes > 0 ? 'warning' : 'success',
    title: 'Theme applied',
    body: notes > 0 ? `${notes} note${notes === 1 ? '' : 's'} in the report.` : 'One undo reverts it.',
    location: 'site-editor',
  })
}

/** The toast after a failed or cancelled theme. */
export function toastThemeApplyFailed(err: unknown): void {
  if (isFragmentCommitCancel(err)) {
    pushToast({ kind: 'info', title: 'Theme cancelled', body: 'Files already uploaded stay in the media library.' })
    return
  }
  pushToast({ kind: 'error', title: 'Theme not applied', body: getErrorMessage(err, 'Unknown theme error') })
}
