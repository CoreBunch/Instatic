import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React, { type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from '@admin/lib/routing'
import { Toolbar } from '@site/toolbar/Toolbar'
import { AdminSessionProvider } from '@admin/session'
import { StepUpProvider } from '@admin/shared/StepUp'
import { useAdminUi } from '@admin/state/adminUi'
import type { CmsCurrentUser } from '@core/persistence'

const now = '2026-06-10T10:00:00.000Z'

function toolbarUser(): CmsCurrentUser {
  return {
    id: 'toolbar-brand-user',
    email: 'admin@example.com',
    displayName: 'Admin',
    status: 'active',
    role: {
      id: 'admin',
      slug: 'admin',
      name: 'Admin',
      description: '',
      isSystem: true,
      capabilities: ['site.read', 'site.structure.edit', 'site.content.edit', 'site.style.edit'],
    },
    capabilities: ['site.read', 'site.structure.edit', 'site.content.edit', 'site.style.edit'],
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    passwordUpdatedAt: null,
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaRecoveryCodesRemaining: 0,
    stepUpAuthMode: 'required',
    stepUpWindowMinutes: 15,
    avatarMediaId: null,
    avatarUrl: null,
    gravatarHash: '',
    createdAt: now,
    updatedAt: now,
  }
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AdminSessionProvider user={toolbarUser()}>
        <StepUpProvider>{children}</StepUpProvider>
      </AdminSessionProvider>
    </MemoryRouter>
  )
}

function renderToolbarBrand(props: { siteName: string | null; faviconUrl?: string | null }) {
  render(
    <Wrapper>
      <Toolbar
        siteName={props.siteName}
        faviconUrl={props.faviconUrl ?? null}
        adminNavigationSlot={<span data-testid="toolbar-nav-slot" />}
        rightSlot={<span data-testid="toolbar-right-slot" />}
      />
    </Wrapper>,
  )

  const toolbar = screen.getByTestId('toolbar')
  const brand = within(toolbar).getByTestId('toolbar-site-brand')
  return { toolbar, brand }
}

beforeEach(() => {
  localStorage.clear()
  useAdminUi.setState({ activeLivePath: null })
})

afterEach(() => {
  useAdminUi.setState({ activeLivePath: null })
  cleanup()
})

describe('Toolbar brand mark', () => {
  it('shows a skeleton while the site name is loading', () => {
    const { toolbar, brand } = renderToolbarBrand({
      siteName: null,
      faviconUrl: null,
    })

    expect(brand.tagName).toBe('SPAN')
    expect(brand.textContent).toBe('')
    expect(brand.getAttribute('aria-hidden')).toBe('true')
    expect(brand.hasAttribute('role')).toBe(false)
    expect(within(toolbar).queryByText('Untitled Site')).toBeNull()
  })

  it('shows the site name when the site has no configured favicon', () => {
    const { toolbar, brand } = renderToolbarBrand({
      siteName: 'Studio Site',
      faviconUrl: null,
    })

    expect(brand.tagName).toBe('SPAN')
    expect(brand.textContent).toBe('Studio Site')
    expect(brand.getAttribute('aria-label')).toBe('Site: Studio Site')
    expect(within(toolbar).queryByRole('img', { name: 'Site: Studio Site' })).toBeNull()
  })

  it('prefers the site favicon from settings when present', () => {
    const { brand } = renderToolbarBrand({
      siteName: 'Configured Site',
      faviconUrl: '/uploads/site-favicon.svg',
    })

    expect(brand.tagName).toBe('IMG')
    expect(brand.getAttribute('src')).toBe('/uploads/site-favicon.svg')
    expect(brand.getAttribute('alt')).toBe('Site: Configured Site')
  })

  it('shows the configured favicon site name in the shared tooltip', async () => {
    const { brand } = renderToolbarBrand({
      siteName: 'Tooltip Site',
      faviconUrl: '/uploads/site-favicon.svg',
    })

    fireEvent.mouseEnter(brand)

    expect((await screen.findByRole('tooltip')).textContent).toBe('Tooltip Site')
    expect(brand.hasAttribute('title')).toBe(false)
  })
})
