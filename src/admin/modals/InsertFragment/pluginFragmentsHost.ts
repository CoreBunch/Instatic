/**
 * The site editor's implementation of `api.editor.fragments` (the plugin
 * runtime checks the permission and the input shape, then calls here).
 *
 * Same flow as the Insert fragment dialog: `planFragmentForEditor` against
 * the open document, then `commitFragmentForEditor` (media through the
 * plugin's `readMediaBytes`, server writes through the step-up prompt, ONE
 * store transaction at the requested placement). Failures resolve as an
 * outcome; only a fragment `parseSiteFragment` refuses rejects, since that is
 * a malformed input.
 *
 * Loaded on the first plugin call (`useBindPluginFragmentsApi` imports it
 * lazily), so the planner stays out of the editor body's chunk.
 */

import {
  FragmentCommitError,
  FragmentInsertError,
  parseSiteFragment,
} from '@core/fragments'
import type {
  FragmentInsertFailureStage,
  FragmentInsertInput,
  FragmentInsertOutcome,
  FragmentPlanInput,
  FragmentPlanOutcome,
  FragmentPreviewStylesListener,
} from '@core/plugin-sdk'
import { styleRuleSelector, type SiteDocument } from '@core/page-tree'
import { generateCanvasClassCSS } from '@site/canvas/canvasClassCss'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import { fragmentInsertDocument } from '@site/store/slices/fragmentsSlice'
import {
  commitFragmentForEditor,
  isFragmentInsertCancel,
  planFragmentForEditor,
  toastFragmentInsertFailed,
  toastFragmentInserted,
  type EditorFragmentPlan,
} from './fragmentInsertFlow'
import { captureFragmentTarget } from './fragmentInsertTarget'

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
  if (isFragmentInsertCancel(err)) return 'cancelled'
  if (err instanceof FragmentCommitError) return err.stage
  return 'commit'
}

export async function planFragmentForPlugin(
  input: FragmentPlanInput,
  target = captureFragmentTarget(),
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
    const result = await commitFragmentForEditor(attempt.plan, {
      readMediaBytes: input.readMediaBytes,
      runStepUp,
      placement: input.placement,
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
