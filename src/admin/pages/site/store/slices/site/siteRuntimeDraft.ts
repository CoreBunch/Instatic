/**
 * Site runtime config lives in two places: persisted on the site document
 * (`site.runtime`, what the collab relay and publish read) and mirrored on
 * the store (`state.siteRuntime`, what the canvas build and Code tab read
 * without touching the document). Every writer must set both, in the same
 * recipe, or the two drift until the next load — go through these helpers.
 */
import type { Draft } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import type { SiteRuntimeConfig } from '@core/site-runtime'
import type { EditorStore } from '@site/store/types'

export function writeSiteRuntimeDraft(
  state: Draft<EditorStore>,
  site: SiteDocument,
  runtime: SiteRuntimeConfig,
): void {
  state.siteRuntime = runtime
  site.runtime = runtime
}

/** The runtime config with every setting for `fileId` dropped. */
export function siteRuntimeWithoutFile(runtime: SiteRuntimeConfig, fileId: string): SiteRuntimeConfig {
  const scripts = { ...runtime.scripts }
  const styles = { ...runtime.styles }
  delete scripts[fileId]
  delete styles[fileId]
  return { ...runtime, scripts, styles }
}
