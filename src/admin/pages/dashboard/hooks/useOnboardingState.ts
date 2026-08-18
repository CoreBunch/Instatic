/**
 * useOnboardingState — fetch the five onboarding-step facts the
 * DashboardPage needs in one place.
 *
 *   • Site identity — done when `site.name` differs from the default
 *     ("Untitled Site") OR the favicon has been set.
 *   • Framework import — derived from `site.settings.framework` being
 *     populated. Defaults to `'active'` so the user is nudged to make a
 *     deliberate decision; once they pick a mode the step flips to done.
 *   • Tour — done when the `editor-tour` user preference status is
 *     `'completed'`. A `'dismissed'` tour (or never started) stays
 *     `'todo'` — deliberate: dismissing the tour isn't the same as
 *     learning the editor, so the step never nags, it just stays
 *     unchecked until the user actually finishes it.
 *   • First page — done when ≥ 2 pages exist (the seed Home page
 *     doesn't count).
 *   • Team — done when the `team-roles-viewed` user preference is set,
 *     i.e. the user has opened the Roles tab of the Users page (see
 *     RolesTab's mount effect). Viewing the team is the step — inviting
 *     members is optional, so headcount deliberately doesn't matter.
 *
 * Reads concurrently in `Promise.all` so the dashboard renders the
 * first paint of the panel after a single round trip's worth of
 * latency. Soft-fails on any individual error so a broken endpoint
 * doesn't brick the dashboard — the step just shows as "not started".
 */
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { cmsAdapter } from '@core/persistence/cms'
import { getUserPreference } from '@core/persistence/userPreferences'

export type OnboardingStepState = 'done' | 'active' | 'todo'

export interface OnboardingFacts {
  loading: boolean
  identity: OnboardingStepState
  framework: OnboardingStepState
  tour: OnboardingStepState
  firstPage: OnboardingStepState
  team: OnboardingStepState
}

const INITIAL: OnboardingFacts = {
  loading: true,
  identity: 'todo',
  framework: 'active',
  tour: 'todo',
  firstPage: 'todo',
  team: 'todo',
}

export interface OnboardingStateResult {
  facts: OnboardingFacts
  /** Re-run the live CMS lookups (e.g. after importing the framework). */
  refresh: () => void
}

export function useOnboardingState(): OnboardingStateResult {
  // `Promise.allSettled` never rejects — each individual failure soft-fails to
  // an empty/undefined value so a broken endpoint doesn't brick the dashboard.
  const { data, refresh } = useAsyncResource<OnboardingFacts>(async () => {
    const [siteResult, tourResult, rolesViewedResult] = await Promise.allSettled([
      cmsAdapter.loadSite('default'),
      getUserPreference('editor-tour'),
      getUserPreference('team-roles-viewed'),
    ])

    const site = siteResult.status === 'fulfilled' ? siteResult.value?.site : undefined
    const tourPref = tourResult.status === 'fulfilled' ? tourResult.value : null
    const rolesViewed =
      rolesViewedResult.status === 'fulfilled' && rolesViewedResult.value !== null

    const hasIdentity = Boolean(site && site.name && site.name !== 'Untitled Site')
    const hasFavicon = Boolean(site?.settings?.faviconUrl)
    const hasFramework = Boolean(site?.settings?.framework)
    const pageCount = Array.isArray(site?.pages) ? site.pages.length : 0

    return {
      loading: false,
      identity: hasIdentity || hasFavicon ? 'done' : 'active',
      framework: hasFramework ? 'done' : 'active',
      tour: tourPref?.status === 'completed' ? 'done' : 'todo',
      firstPage: pageCount >= 2 ? 'done' : 'todo',
      team: rolesViewed ? 'done' : 'todo',
    }
  }, [])

  return { facts: data ?? INITIAL, refresh }
}
