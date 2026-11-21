/**
 * useOnboardingState — fetch the five onboarding-step facts the
 * DashboardPage needs in one place.
 *
 *   • Site identity — done when `site.name` differs from the default
 *     ("Untitled Site") OR the favicon has been set.
 *   • Framework import — derived from `site.settings.framework` being
 *     populated. Defaults to `'active'` so the user is nudged to make a
 *     deliberate decision; once they pick a mode the step flips to done.
 *   • Home page — setup seeds one empty, unpublished Home page. The step
 *     is `'active'` until at least one page is published (the dashboard
 *     `pages` stats `published` count), then done. Publishing is the
 *     signal because it is what puts the site on the frontend, and it
 *     completes for a one-page site as well as for an imported one.
 *   • First plugin — done when any plugin is installed.
 *   • Team — done when more than the owner is in the users table.
 *
 * Reads concurrently in `Promise.allSettled` so the dashboard renders the
 * first paint of the panel after a single round trip's worth of
 * latency. Soft-fails on any individual error so a broken endpoint
 * doesn't brick the dashboard — the step just shows as "not started"
 * (or "in progress" for the steps whose nudge state is active).
 */
import type { Static } from '@core/utils/typeboxHelpers'
import type { SiteDocument } from '@core/page-tree'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { cmsAdapter } from '@core/persistence/cms'
import { listCmsPlugins } from '@core/persistence/cmsPlugins'
import { listCmsUsers } from '@core/persistence/cmsUsers'
import { DashboardPagesStatsSchema, fetchDashboardEndpoint } from './useDashboardStats'

export type OnboardingStepState = 'done' | 'active' | 'todo'

export interface OnboardingFacts {
  loading: boolean
  identity: OnboardingStepState
  framework: OnboardingStepState
  homePage: OnboardingStepState
  plugin: OnboardingStepState
  team: OnboardingStepState
}

const INITIAL: OnboardingFacts = {
  loading: true,
  identity: 'todo',
  framework: 'active',
  homePage: 'active',
  plugin: 'todo',
  team: 'todo',
}

/** The raw lookups `deriveOnboardingFacts` turns into step states. Each is `undefined` when its read failed. */
export interface OnboardingLookups {
  site: SiteDocument | undefined
  pagesStats: Static<typeof DashboardPagesStatsSchema> | undefined
  pluginCount: number | undefined
  userCount: number | undefined
}

/** Pure mapping from lookups to step states, so the rules are testable without the network. */
export function deriveOnboardingFacts(lookups: OnboardingLookups): OnboardingFacts {
  const { site, pagesStats, pluginCount, userCount } = lookups
  const hasIdentity = Boolean(site && site.name && site.name !== 'Untitled Site')
  const hasFavicon = Boolean(site?.settings?.faviconUrl)
  const hasFramework = Boolean(site?.settings?.framework)
  const publishedPages = pagesStats?.published ?? 0

  return {
    loading: false,
    identity: hasIdentity || hasFavicon ? 'done' : 'active',
    framework: hasFramework ? 'done' : 'active',
    homePage: publishedPages >= 1 ? 'done' : 'active',
    plugin: (pluginCount ?? 0) > 0 ? 'done' : 'todo',
    team: (userCount ?? 0) > 1 ? 'done' : 'todo',
  }
}

export interface OnboardingStateResult {
  facts: OnboardingFacts
  /** Re-run the live CMS lookups (e.g. after importing the framework). */
  refresh: () => void
}

export function useOnboardingState(): OnboardingStateResult {
  // `Promise.allSettled` never rejects — each individual failure soft-fails to
  // `undefined` so a broken endpoint doesn't brick the dashboard.
  const { data, refresh } = useAsyncResource<OnboardingFacts>(async (signal) => {
    const [siteResult, pagesResult, pluginsResult, usersResult] = await Promise.allSettled([
      cmsAdapter.loadSite('default'),
      fetchDashboardEndpoint('pages', DashboardPagesStatsSchema, signal),
      listCmsPlugins(),
      listCmsUsers(),
    ])

    return deriveOnboardingFacts({
      site: siteResult.status === 'fulfilled' ? siteResult.value?.site : undefined,
      pagesStats: pagesResult.status === 'fulfilled' ? pagesResult.value : undefined,
      pluginCount: pluginsResult.status === 'fulfilled' ? pluginsResult.value.plugins.length : undefined,
      userCount: usersResult.status === 'fulfilled' ? usersResult.value.length : undefined,
    })
  }, [])

  return { facts: data ?? INITIAL, refresh }
}
