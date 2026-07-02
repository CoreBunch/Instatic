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
import { MemoryRouter } from '@admin/lib/routing'
import { cmsAdapter } from '@core/persistence/cms'
import type { SiteDocument } from '@core/page-tree'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { OnboardingPanel } from './OnboardingPanel'
import type { OnboardingFacts } from '../hooks/useOnboardingState'

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
  identity: 'active',
  framework: 'active',
  firstPage: 'active',
  plugin: 'active',
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
