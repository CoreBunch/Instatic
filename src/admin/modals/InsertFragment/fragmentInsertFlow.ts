/**
 * The Insert fragment dialog's steps, outside React so the component body
 * stays compilable: read a picked file, plan against the open document, and
 * run the commit.
 */

import {
  FragmentParseError,
  commitFragmentPlan,
  parseSiteFragment,
  planFragmentInsert,
  readFragmentPackage,
  type FragmentInsertPlan,
  type FragmentInsertResult,
  type FragmentMedia,
  type SiteFragment,
} from '@core/fragments'
import { listCmsDataTables } from '@core/persistence/cmsData'
import { useEditorStore } from '@site/store/store'
import { fragmentInsertDocument } from '@site/store/slices/fragmentsSlice'
import { createFragmentInsertAdapter } from './createFragmentInsertAdapter'

export interface LoadedFragment {
  fileName: string
  fragment: SiteFragment
  readMedia(media: FragmentMedia): Uint8Array | null
}

/**
 * A fragment package (`.zip`: `fragment.json` + media) or a bare
 * `fragment.json`. A bare JSON file can only carry a fragment without media —
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

/** Plan the insert against the open document and the site's data tables. */
export async function planLoadedFragment(loaded: LoadedFragment): Promise<FragmentInsertPlan> {
  const tables = await listCmsDataTables()
  const state = useEditorStore.getState()
  if (!state.site) throw new Error('The site is still loading.')
  return planFragmentInsert(
    { site: state.site, tables, document: fragmentInsertDocument(state) ?? undefined },
    loaded.fragment,
  )
}

export function runFragmentInsert(
  loaded: LoadedFragment,
  plan: FragmentInsertPlan,
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  signal: AbortSignal,
  onProgress: (line: string) => void,
): Promise<FragmentInsertResult> {
  return commitFragmentPlan(plan, createFragmentInsertAdapter(runStepUp), {
    readMediaBytes: loaded.readMedia,
    signal,
    onProgress: ({ phase, done, total, label }) => {
      if (phase === 'media') onProgress(`Adding media ${done + 1} of ${total}${label ? `: ${label}` : ''}`)
      else if (phase === 'fonts') onProgress(`Installing fonts${label ? `: ${label}` : ''}`)
      else if (phase === 'tables') onProgress(`Writing tables${label ? `: ${label}` : ''}`)
      else onProgress('Placing the fragment')
    },
  })
}
