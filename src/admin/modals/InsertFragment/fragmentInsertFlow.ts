/**
 * The editor's fragment insert flow, outside React so component bodies stay
 * compilable: read a picked file, plan against the open document, run the
 * commit, and announce the result. The Insert fragment dialog and the plugin
 * API (`api.editor.fragments`, `pluginFragmentsHost.ts`) both go through
 * `planFragmentForEditor` and `commitFragmentForEditor`, so there is one
 * insert path.
 */

import {
  FragmentParseError,
  commitFragmentPlan,
  parseSiteFragment,
  planFragmentInsert,
  readFragmentPackage,
  type CommitFragmentPlanOptions,
  type FragmentInsertPlacement,
  type FragmentInsertPlan,
  type FragmentInsertResult,
  type FragmentMedia,
  type FragmentPlanOptions,
  type SiteFragment,
} from '@core/fragments'
import { isAbortError } from '@core/http'
import { listCmsDataTables } from '@core/persistence/cmsData'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import { useEditorStore } from '@site/store/store'
import { fragmentInsertDocument } from '@site/store/slices/fragmentsSlice'
import { createFragmentInsertAdapter } from './createFragmentInsertAdapter'

type RunStepUp = <T>(action: () => Promise<T>) => Promise<T>
type FragmentProgress = Parameters<NonNullable<CommitFragmentPlanOptions['onProgress']>>[0]

export interface LoadedFragment {
  fileName: string
  fragment: SiteFragment
  readMedia(media: FragmentMedia): Uint8Array | null
}

/**
 * A fragment package (`.zip`: `fragment.json` + media) or a bare
 * `fragment.json`. A bare JSON file can only carry a fragment without media:
 * its media bytes have nowhere to come from.
 */
export async function loadFragmentFile(file: File): Promise<LoadedFragment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (file.name.toLowerCase().endsWith('.json')) {
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new FragmentParseError('fragment.json', 'not valid JSON')
    }
    const fragment = parseSiteFragment(raw)
    if (fragment.media.length > 0) {
      throw new FragmentParseError('media', 'this fragment has media; insert its .zip package instead')
    }
    return { fileName: file.name, fragment, readMedia: () => null }
  }
  const pkg = readFragmentPackage(bytes)
  return { fileName: file.name, fragment: pkg.fragment, readMedia: pkg.readMedia }
}

/** Plan an insert against the open document and the site's data tables. */
export async function planFragmentForEditor(fragment: SiteFragment, options: FragmentPlanOptions = {}): Promise<FragmentInsertPlan> {
  const tables = await listCmsDataTables()
  const state = useEditorStore.getState()
  if (!state.site) throw new Error('The site is still loading.')
  return planFragmentInsert(
    { site: state.site, tables, document: fragmentInsertDocument(state) ?? undefined },
    fragment,
    options,
  )
}

export interface CommitFragmentRequest extends CommitFragmentPlanOptions {
  /** The admin shell's step-up runner: table writes may need a recent password. */
  runStepUp: RunStepUp
  /** Default `after-selection`. */
  placement?: FragmentInsertPlacement
}

/** Media, fonts, tables, then ONE store transaction. */
export function commitFragmentForEditor(
  plan: FragmentInsertPlan,
  { runStepUp, placement, ...options }: CommitFragmentRequest,
): Promise<FragmentInsertResult> {
  return commitFragmentPlan(plan, createFragmentInsertAdapter(runStepUp, placement), options)
}

/** The dialog's progress line for one step of the commit. */
export function fragmentProgressLine({ phase, done, total, label }: FragmentProgress): string {
  if (phase === 'media') return `Adding media ${done + 1} of ${total}${label ? `: ${label}` : ''}`
  if (phase === 'fonts') return `Installing fonts${label ? `: ${label}` : ''}`
  if (phase === 'tables') return `Writing tables${label ? `: ${label}` : ''}`
  return 'Placing the fragment'
}

/** The insert was aborted, or the user closed the password prompt a table write asked for. */
export function isFragmentInsertCancel(err: unknown): boolean {
  if (isAbortError(err)) return true
  const cause = err instanceof Error ? err.cause : undefined
  return cause instanceof Error && cause.message === StepUpCancelledMessage
}

/** The result toast after a successful insert. */
export function toastFragmentInserted(result: FragmentInsertResult): void {
  const notes = result.report.warnings.length
  pushToast({
    kind: notes > 0 ? 'warning' : 'success',
    title: result.pageId ? 'Page added' : 'Fragment inserted',
    body: notes > 0 ? `${notes} note${notes === 1 ? '' : 's'} in the report.` : 'One undo removes it.',
    location: 'site-editor',
  })
}

/** The toast after a failed or cancelled insert. */
export function toastFragmentInsertFailed(err: unknown): void {
  if (isFragmentInsertCancel(err)) {
    pushToast({ kind: 'info', title: 'Insert cancelled', body: 'Files already uploaded stay in the media library.' })
    return
  }
  pushToast({ kind: 'error', title: 'Insert failed', body: getErrorMessage(err, 'Unknown insert error') })
}
