/**
 * The site editor's implementation of `api.editor.fragments` (the plugin
 * runtime checks the permission and the input shape, then calls here).
 *
 * Inserts use the Insert fragment dialog's flow: `planFragmentForEditor`
 * against the open document, then `commitFragmentForEditor` (media through
 * the plugin's `readMediaBytes`, server writes through the step-up prompt,
 * ONE store transaction at the requested placement). Themes use
 * `planThemeForEditor` / `commitThemeForEditor` the same way. Failures
 * resolve as an outcome. Malformed input rejects an insert or apply request.
 *
 * Loaded on the first plugin call (`useBindPluginFragmentsApi` imports it
 * lazily), so the planner stays out of the editor body's chunk.
 */

import {
  placeFragmentLayout,
  loadFragmentAssets,
  FragmentCommitError,
  FragmentInsertError,
  parseSiteFragment,
  parseSiteTheme,
  type SiteTheme,
  type ThemeApplyPlan,
} from '@core/fragments'
import type { EditorFragmentPlacement } from '@site/store/slices/fragmentsSlice'
import type {
  FragmentInsertFailureStage,
  FragmentInsertInput,
  FragmentInsertOutcome,
  FragmentPlanInput,
  FragmentPlanOutcome,
  FragmentPreviewStylesListener,
  ThemeApplyFailureStage,
  ThemeApplyInput,
  ThemeApplyOutcome,
  ThemePlanInput,
  ThemePlanOutcome,
} from '@core/plugin-sdk'
import { styleRuleSelector, type SiteDocument } from '@core/page-tree'
import { generateCanvasClassCSS } from '@site/canvas/canvasClassCss'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import { fragmentInsertDocument } from '@site/store/slices/fragmentsSlice'
import {
  commitFragmentForEditor,
  isFragmentCommitCancel,
  planFragmentForEditor,
  toastFragmentInsertFailed,
  toastFragmentInserted,
  type EditorFragmentPlan,
} from './fragmentInsertFlow'
import { createFragmentInsertAdapter } from './createFragmentInsertAdapter'
import { pushToast } from '@ui/components/Toast'
import { captureFragmentTarget, capturePreviewBranch, captureThemeTarget } from './fragmentInsertTarget'
import { commitThemeForEditor, planThemeForEditor, toastThemeApplied, toastThemeApplyFailed } from './themeApplyFlow'

export function watchFragmentPreviewStyles(onChange: FragmentPreviewStylesListener): () => void {
  let previous: SiteDocument | null | undefined
  const update = (site: SiteDocument | null) => {
    const last = previous
    previous = site
    if (site === last) return
    if (!site) {
      onChange(null)
      return
    }
    if (last && site.styleRules === last.styleRules && site.breakpoints === last.breakpoints
      && site.conditions === last.conditions && site.settings.framework === last.settings.framework
      && site.settings.fonts === last.settings.fonts) return

    // A fragment can use an authored class before any canvas node uses it.
    // Keep the full shared registry and leave node-owned module rules out.
    const sharedRules = Object.values(site.styleRules).filter(rule => !rule.scope)
    const registry = Object.fromEntries(sharedRules.map(rule => [rule.id, rule]))
    const framework = site.settings.framework
    const css = generateCanvasClassCSS(
      registry, site.breakpoints, site.conditions, framework?.colors,
      framework?.typography, framework?.spacing, framework?.preferences, site.settings.fonts,
    )
    onChange({
      css,
      rules: sharedRules.map(rule => ({ kind: rule.kind, name: rule.name, selector: styleRuleSelector(rule) })),
    })
  }
  update(useEditorStore.getState().site)
  return useEditorStore.subscribe(state => update(state.site))
}

type RunStepUp = <T>(action: () => Promise<T>) => Promise<T>

type PlanAttempt =
  | { ok: true; plan: EditorFragmentPlan }
  | { ok: false; stage: 'unavailable' | 'plan'; message: string }

async function planForActiveDocument(
  fragment: unknown,
  colorSources: Record<string, string> | undefined,
  target: () => void,
): Promise<PlanAttempt> {
  // Throws FragmentParseError for a malformed fragment: the caller decides
  // whether that rejects (insert) or resolves (plan).
  const parsed = parseSiteFragment(fragment)
  const state = useEditorStore.getState()
  if (!state.site || (parsed.kind !== 'page' && !fragmentInsertDocument(state))) {
    return { ok: false, stage: 'unavailable', message: 'Open a page or component in the site editor to insert a fragment.' }
  }
  try {
    return { ok: true, plan: await planFragmentForEditor(parsed, { colorSources }, target) }
  } catch (err) {
    const message = err instanceof FragmentInsertError
      ? err.message
      : `Could not plan the insert: ${getErrorMessage(err, 'unknown error')}`
    return { ok: false, stage: 'plan', message }
  }
}

function failureStage(err: unknown): FragmentInsertFailureStage {
  if (isFragmentCommitCancel(err)) return 'cancelled'
  if (err instanceof FragmentCommitError) return err.stage
  return 'commit'
}

export async function planFragmentForPlugin(
  input: FragmentPlanInput,
  target = capturePreviewBranch(),
): Promise<FragmentPlanOutcome> {
  let attempt: PlanAttempt
  try {
    attempt = await planForActiveDocument(input.fragment, input.colorSources, target)
  } catch (err) {
    return { ok: false, message: getErrorMessage(err, 'The fragment is not valid.') }
  }
  return attempt.ok ? { ok: true, report: attempt.plan.report } : { ok: false, message: attempt.message }
}

export async function insertFragmentForPlugin(
  input: FragmentInsertInput,
  runStepUp: RunStepUp,
  target = captureFragmentTarget(),
  placement: EditorFragmentPlacement | undefined = input.placement,
): Promise<FragmentInsertOutcome> {
  const announce = input.silent !== true
  const attempt = await planForActiveDocument(input.fragment, input.colorSources, target)
  if (!attempt.ok) {
    if (announce) toastFragmentInsertFailed(new Error(attempt.message))
    return attempt
  }
  if (input.signal?.aborted) {
    return { ok: false, stage: 'cancelled', message: 'The insert was cancelled.' }
  }
  try {
    if (input.assets) {
      const plan = attempt.plan
      const backgroundTarget = capturePreviewBranch()
      const adapter = createFragmentInsertAdapter(runStepUp, target, placement)
      const options = { readMediaBytes: input.readMediaBytes, signal: input.signal, onProgress: input.onProgress }
      const layoutOnly = input.assets === 'layout-only'
      const { result, placeholders, tableIdMap } = await placeFragmentLayout(plan, adapter, options, layoutOnly)
      const report = layoutOnly ? {
        ...plan.report,
        tables: { ...plan.report.tables, created: [], fieldsAdded: [], rows: 0 },
        fonts: { ...plan.report.fonts, familiesAdded: [] },
        media: { total: 0, uploaded: 0, reused: 0 },
      } : plan.report
      if (announce) toastFragmentInserted({ ...result, report })
      if (!layoutOnly && (plan.media.length || plan.fontFamilies.length || plan.tables.some(table => table.action === 'create' && table.rows.length))) {
        const assetsAdapter = createFragmentInsertAdapter(runStepUp, backgroundTarget)
        void loadFragmentAssets(plan, tableIdMap, assetsAdapter, options).then(async ({ media, fonts, warnings, seedRows }) => {
          options.signal?.throwIfAborted()
          backgroundTarget()
          useEditorStore.getState().finishFragmentAssets(plan, { placeholders, media, fonts })
          await seedRows()
          if (warnings.length) pushToast({ kind: 'warning', title: 'Some assets could not be imported', body: warnings[0].message, location: 'site-editor' })
        }).catch(error => pushToast({ kind: 'warning', title: 'Asset import interrupted', body: getErrorMessage(error, 'The layout is in your draft.'), location: 'site-editor' }))
      }
      return { ok: true, insertedRootIds: result.rootIds, pageId: result.pageId, report }
    }
    const result = await commitFragmentForEditor(attempt.plan, {
      readMediaBytes: input.readMediaBytes,
      runStepUp,
      placement,
      signal: input.signal,
      onProgress: input.onProgress,
    })
    if (announce) toastFragmentInserted(result)
    return {
      ok: true,
      report: result.report,
      insertedRootIds: result.rootIds,
      ...(result.pageId ? { pageId: result.pageId } : {}),
    }
  } catch (err) {
    if (announce) toastFragmentInsertFailed(err)
    const stage = failureStage(err)
    return {
      ok: false,
      stage,
      message: stage === 'cancelled' ? 'The insert was cancelled.' : getErrorMessage(err, 'Unknown insert error'),
    }
  }
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

type ThemePlanAttempt =
  | { ok: true; plan: ThemeApplyPlan }
  | { ok: false; stage: 'unavailable' | 'plan'; message: string }

function planThemeForSite(theme: SiteTheme, assertCurrentTarget: () => void): ThemePlanAttempt {
  if (!useEditorStore.getState().site) {
    return { ok: false, stage: 'unavailable', message: 'Open the site editor to apply a theme.' }
  }
  try {
    assertCurrentTarget()
    return { ok: true, plan: planThemeForEditor(theme) }
  } catch (err) {
    return { ok: false, stage: 'plan', message: `Could not plan the theme: ${getErrorMessage(err, 'unknown error')}` }
  }
}

export async function planThemeForPlugin(
  input: ThemePlanInput,
  assertCurrentTarget = captureThemeTarget(),
): Promise<ThemePlanOutcome> {
  let theme: SiteTheme
  try {
    theme = parseSiteTheme(input.theme)
  } catch (err) {
    return { ok: false, message: getErrorMessage(err, 'The theme is not valid.') }
  }
  const attempt = planThemeForSite(theme, assertCurrentTarget)
  return attempt.ok ? { ok: true, report: attempt.plan.report } : { ok: false, message: attempt.message }
}

export async function applyThemeForPlugin(
  input: ThemeApplyInput,
  runStepUp: RunStepUp,
  assertCurrentTarget = captureThemeTarget(),
): Promise<ThemeApplyOutcome> {
  const announce = input.silent !== true
  // Throws FragmentParseError for a malformed theme: a malformed input rejects.
  const attempt = planThemeForSite(parseSiteTheme(input.theme), assertCurrentTarget)
  if (!attempt.ok) {
    if (announce) toastThemeApplyFailed(new Error(attempt.message))
    return attempt
  }
  if (input.signal?.aborted) {
    return { ok: false, stage: 'cancelled', message: 'The theme was cancelled.' }
  }
  try {
    const result = await commitThemeForEditor(attempt.plan, {
      readMediaBytes: input.readMediaBytes,
      runStepUp,
      assertCurrentTarget,
      signal: input.signal,
      onProgress: input.onProgress,
    })
    if (announce) toastThemeApplied(result)
    return { ok: true, report: result.report }
  } catch (err) {
    if (announce) toastThemeApplyFailed(err)
    const stage: ThemeApplyFailureStage = isFragmentCommitCancel(err)
      ? 'cancelled'
      : err instanceof FragmentCommitError ? 'media' : 'commit'
    return {
      ok: false,
      stage,
      message: stage === 'cancelled' ? 'The theme was cancelled.' : getErrorMessage(err, 'Unknown theme error'),
    }
  }
}
