/**
 * The onboarding step rules, exercised through the pure `deriveOnboardingFacts`
 * so no network or store is involved. The Home page rule is the one that
 * matters: setup seeds an empty, unpublished Home page, and the step must read
 * "In progress" until something is published, then "Completed". Counting
 * pages (the old rule) could never complete for a one-page site.
 */
import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree'
import { deriveOnboardingFacts, type OnboardingLookups } from './useOnboardingState'

function site(overrides: Partial<SiteDocument> = {}): SiteDocument {
  return { name: 'Untitled Site', settings: {}, pages: [], ...overrides } as unknown as SiteDocument
}

function lookups(overrides: Partial<OnboardingLookups> = {}): OnboardingLookups {
  return {
    site: site(),
    pagesStats: { total: 1, published: 0, drafts: 1, scheduled: 0, deltaPublishedThisWeek: 0 },
    pluginCount: 0,
    userCount: 1,
    ...overrides,
  }
}

describe('deriveOnboardingFacts — Home page step', () => {
  it('is in progress on a fresh install, where the seeded Home page is unpublished', () => {
    expect(deriveOnboardingFacts(lookups()).homePage).toBe('active')
  })

  it('completes once a page is published, even when it is the only page', () => {
    const facts = deriveOnboardingFacts(
      lookups({ pagesStats: { total: 1, published: 1, drafts: 0, scheduled: 0, deltaPublishedThisWeek: 1 } }),
    )
    expect(facts.homePage).toBe('done')
  })

  it('stays in progress while pages are only drafts, however many there are', () => {
    const facts = deriveOnboardingFacts(
      lookups({ pagesStats: { total: 4, published: 0, drafts: 4, scheduled: 0, deltaPublishedThisWeek: 0 } }),
    )
    expect(facts.homePage).toBe('active')
  })

  it('soft-fails to in progress when the pages stats read failed', () => {
    expect(deriveOnboardingFacts(lookups({ pagesStats: undefined })).homePage).toBe('active')
  })
})

describe('deriveOnboardingFacts — the other steps', () => {
  it('reports a clean install as identity and framework active, plugin and team not started', () => {
    expect(deriveOnboardingFacts(lookups())).toEqual({
      loading: false,
      identity: 'active',
      framework: 'active',
      homePage: 'active',
      plugin: 'todo',
      team: 'todo',
    })
  })

  it('flips identity on a renamed site or a favicon, framework on a chosen mode, plugin and team on counts', () => {
    const facts = deriveOnboardingFacts(
      lookups({
        site: site({ name: 'Acme', settings: { faviconUrl: '/favicon.png', framework: { mode: 'full' } } } as Partial<SiteDocument>),
        pluginCount: 2,
        userCount: 3,
      }),
    )
    expect(facts.identity).toBe('done')
    expect(facts.framework).toBe('done')
    expect(facts.plugin).toBe('done')
    expect(facts.team).toBe('done')
  })

  it('treats failed plugin and user reads as not started', () => {
    const facts = deriveOnboardingFacts(lookups({ pluginCount: undefined, userCount: undefined }))
    expect(facts.plugin).toBe('todo')
    expect(facts.team).toBe('todo')
  })
})
