/**
 * OnboardingPanel — regression coverage for the post-import editor sync.
 *
 * The onboarding framework import writes `settings.framework` straight to
 * storage via cmsAdapter (it has no live editor / reconcile). The Site editor's
 * store is a session-lived singleton, and `usePersistence`'s mount-load
 * early-returns when a site is already hydrated — so without an explicit reload
 * signal the editor keeps the pre-import framework ("stuck on variables only").
 * This pins the fix: a successful onboarding import dispatches
 * CMS_SITE_RELOAD_EVENT so the editor refetches.
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from '@admin/lib/routing'
import { cmsAdapter } from '@core/persistence/cms'
import type { SiteDocument } from '@core/page-tree'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { peekPendingAction } from '@admin/spotlight/pendingAction'
import { OnboardingPanel } from './OnboardingPanel'
import type { OnboardingFacts } from '../hooks/useOnboardingState'

/** Renders the current in-memory route so tests can assert on navigation. */
function LocationProbe() {
  const { pathname } = useLocation()
  return <span data-testid="location-probe">{pathname}</span>
}

afterEach(cleanup)

function fakeSite(): SiteDocument {
  return {
    id: 'default',
    name: 'Test',
    breakpoints: [],
    settings: { shortcuts: {} },
    styleRules: {},
    files: [],
    explorer: { sections: [] } as unknown as SiteDocument['explorer'],
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: {} as SiteDocument['runtime'],
    createdAt: 0,
    updatedAt: 0,
    pages: [],
    visualComponents: [],
    layouts: [],
  } as unknown as SiteDocument
}

const FACTS: OnboardingFacts = {
  loading: false,
  identity: 'active',
  framework: 'active',
  tour: 'active',
  firstPage: 'active',
  team: 'active',
}

describe('OnboardingPanel framework import', () => {
  it('dispatches a CMS site reload after a successful import so the editor refetches', async () => {
    const loadSpy = spyOn(cmsAdapter, 'loadSite')
      .mockResolvedValue({ site: fakeSite(), rowSeqs: {}, shellSeq: 0 })
    const saveSpy = spyOn(cmsAdapter, 'saveSite').mockResolvedValue({ seq: 1 })

    let reloadFired = false
    const onReload = () => { reloadFired = true }
    window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)

    const onFrameworkImported = mock(() => {})

    try {
      render(
        <MemoryRouter initialEntries={['/admin/dashboard']}>
          <OnboardingPanel
            facts={FACTS}
            onDismiss={() => {}}
            onFrameworkImported={onFrameworkImported}
          />
        </MemoryRouter>,
      )

      // Open the framework-import dialog from the "Choose Core Framework import" step.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^import$/i }))
      })

      // Apply the default (full) import.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /import framework/i }))
      })

      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(reloadFired).toBe(true))
      expect(onFrameworkImported).toHaveBeenCalled()
    } finally {
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, onReload)
      loadSpy.mockRestore()
      saveSpy.mockRestore()
    }
  })
})

describe('OnboardingPanel tour step', () => {
  afterEach(() => {
    globalThis.sessionStorage?.clear()
  })

  it('renders the tour step and no longer offers the removed plugin step', () => {
    render(
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <OnboardingPanel facts={FACTS} onDismiss={() => {}} onFrameworkImported={() => {}} />
      </MemoryRouter>,
    )

    expect(screen.getByText('Tour the editor')).toBeTruthy()
    expect(screen.queryByText('Install a plugin')).toBeNull()
    expect(screen.queryByRole('button', { name: /browse plugins/i })).toBeNull()
  })

  it('queues the site.startTour pending action and navigates to the Site workspace', () => {
    render(
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <OnboardingPanel facts={FACTS} onDismiss={() => {}} onFrameworkImported={() => {}} />
        <LocationProbe />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: /^start tour$/i }))

    expect(peekPendingAction('site.startTour')).not.toBeNull()
    expect(screen.getByTestId('location-probe').textContent).toBe('/admin/site')
  })
})

describe('OnboardingPanel first-page step', () => {
  afterEach(() => {
    globalThis.sessionStorage?.clear()
  })

  it('queues site.revealNewPage and navigates to the Site workspace', () => {
    render(
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <OnboardingPanel facts={FACTS} onDismiss={() => {}} onFrameworkImported={() => {}} />
        <LocationProbe />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: /^new page$/i }))

    expect(peekPendingAction('site.revealNewPage')).not.toBeNull()
    expect(screen.getByTestId('location-probe').textContent).toBe('/admin/site')
  })
})

describe('OnboardingPanel team step', () => {
  afterEach(() => {
    globalThis.sessionStorage?.clear()
  })

  it('is titled "View your team & roles" and no longer asks for invites', () => {
    render(
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <OnboardingPanel facts={FACTS} onDismiss={() => {}} onFrameworkImported={() => {}} />
      </MemoryRouter>,
    )

    expect(screen.getByText('View your team & roles')).toBeTruthy()
    expect(screen.queryByText('Invite your team')).toBeNull()
    expect(screen.queryByRole('button', { name: /add members/i })).toBeNull()
  })

  it('queues users.viewRoles and navigates to the Users workspace', () => {
    render(
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <OnboardingPanel facts={FACTS} onDismiss={() => {}} onFrameworkImported={() => {}} />
        <LocationProbe />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: /^view roles$/i }))

    expect(peekPendingAction('users.viewRoles')).not.toBeNull()
    expect(screen.getByTestId('location-probe').textContent).toBe('/admin/users')
  })
})
