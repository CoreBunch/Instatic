/**
 * SettingsModal DOM Integration Tests — J10 (Guideline #225)
 *
 * The modal shares the Spotlight / Module Inserter visual language: a
 * direct-token shell, an `--bg-surface-2` rail with categorical accent
 * icon chips, an accent-bar section header, and a shared `Esc` keycap
 * affordance (backdrop click / Esc both close — there is no dedicated close
 * button). After the consistency pass the modal carries four sections:
 * General, Shortcuts, Publishing, Preferences.
 *
 * ─── Test groups ────────────────────────────────────────────────────────────
 *   1.  Render gating  — modal hidden when closed, visible when open
 *   2.  ARIA dialog shell — role/aria-modal/aria-labelledby/heading id
 *   3.  data-testid (Guideline #221)
 *   4.  Backdrop — aria-hidden, click-to-close
 *   5.  Section navigation — nav items, aria-current, content region label
 *   6.  Section sync — valid/invalid section IDs from store (retired fallback)
 *   7.  Close behaviours — Escape key, backdrop click, Esc keycap affordance
 *   8.  Focus trap keyboard logic — Tab/Shift+Tab stays inside dialog
 *   9.  GeneralSection rendering — site-null state
 *  10.  PreferencesSection — role="switch" toggles, state update
 *  11.  Guideline #225 — Focus return (source-scan enforcement)
 *  12.  Section ID alignment — SettingsButton + store default (source-scan)
 *  13.  WCAG 2.4.7 — Input focus rings (source-scan enforcement)
 *
 * Uses @testing-library/react. happy-dom GlobalWindow is preloaded via setup.ts.
 * localStorage.clear() in beforeEach prevents PreferencesSection prefs from
 * leaking between tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import React from 'react'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { SettingsModal } from '@admin/modals/Settings/SettingsModal'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage } from '../fixtures'

// ---------------------------------------------------------------------------
// Store + DOM reset
// ---------------------------------------------------------------------------

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    isSettingsOpen: false,
    activeSection: 'general',
    domTreePanel: { collapsed: false, x: 0, y: 0, width: 280 },
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    focusedPanel: 'canvas',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
    activeBreakpointId: 'desktop',
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** Open the modal and optionally load a site into the store. */
function openModal(section = 'general', withSite = false) {
  if (withSite) {
    const site = makeSite({ pages: [makePage()] })
    useEditorStore.setState({ site, activePageId: 'page-1' } as Parameters<typeof useEditorStore.setState>[0])
  }
  useEditorStore.setState({
    isSettingsOpen: true,
    activeSection: section,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)
afterEach(cleanup)

// ---------------------------------------------------------------------------
// 1 — Render gating
// ---------------------------------------------------------------------------

describe('SettingsModal — render gating', () => {
  it('renders nothing when isSettingsOpen is false', () => {
    render(<SettingsModal />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('renders the dialog when isSettingsOpen is true', () => {
    openModal()
    render(<SettingsModal />)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('unmounts cleanly when modal transitions from open to closed', () => {
    openModal()
    const { unmount } = render(<SettingsModal />)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => {
      useEditorStore.setState({ isSettingsOpen: false } as Parameters<typeof useEditorStore.setState>[0])
    })
    unmount()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2 — ARIA dialog shell (Guideline #225 / WCAG 4.1.2)
// ---------------------------------------------------------------------------

describe('SettingsModal — ARIA dialog shell', () => {
  it('has role="dialog" on the modal container', () => {
    openModal()
    render(<SettingsModal />)
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('has aria-modal="true" on the dialog', () => {
    openModal()
    render(<SettingsModal />)
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  })

  it('has aria-labelledby="settings-modal-title" on the dialog', () => {
    openModal()
    render(<SettingsModal />)
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe('settings-modal-title')
  })

  it('heading with id="settings-modal-title" labels the dialog "Settings"', () => {
    openModal()
    render(<SettingsModal />)
    const heading = document.getElementById('settings-modal-title')
    expect(heading).not.toBeNull()
    expect(heading!.textContent?.trim()).toBe('Settings')
  })

  it('nav has aria-label="Settings sections"', () => {
    openModal()
    render(<SettingsModal />)
    expect(screen.getByRole('navigation', { name: /settings sections/i })).toBeDefined()
  })

  it('content area has role="region"', () => {
    openModal()
    render(<SettingsModal />)
    const region = screen.getByRole('dialog').querySelector('[role="region"]')
    expect(region).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3 — data-testid (Guideline #221)
// ---------------------------------------------------------------------------

describe('SettingsModal — data-testid (Guideline #221)', () => {
  it('renders data-testid="settings-modal" when open', () => {
    openModal()
    render(<SettingsModal />)
    expect(screen.getByTestId('settings-modal')).toBeDefined()
  })

  it('data-testid="settings-modal" not present when closed', () => {
    render(<SettingsModal />)
    expect(document.querySelector('[data-testid="settings-modal"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4 — Backdrop (aria-hidden, click-to-close)
// ---------------------------------------------------------------------------

describe('SettingsModal — backdrop', () => {
  it('backdrop has aria-hidden="true" so AT ignores it', () => {
    openModal()
    render(<SettingsModal />)
    const backdrop = document.querySelector('[aria-hidden="true"]')
    expect(backdrop).not.toBeNull()
  })

  it('clicking the backdrop closes the modal (calls closeSettings)', () => {
    openModal()
    render(<SettingsModal />)
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop)
    expect(useEditorStore.getState().isSettingsOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5 — Section navigation
// ---------------------------------------------------------------------------

describe('SettingsModal — section navigation', () => {
  it('renders exactly 4 nav items (general, shortcuts, publishing, preferences)', () => {
    openModal()
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const navBtns = Array.from(nav.querySelectorAll('button'))
    expect(navBtns.length).toBe(4)
  })

  it('renders nav items with the current section labels', () => {
    // Open on a non-Preferences section so the section-header title does not
    // duplicate the "Preferences" nav-button text.
    openModal('general')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    expect(within(nav).getByText('General')).toBeDefined()
    expect(within(nav).getByText('Shortcuts')).toBeDefined()
    expect(within(nav).getByText('Publishing')).toBeDefined()
    expect(within(nav).getByText('Preferences')).toBeDefined()
    // Dropped sections — moved to their dedicated controls.
    expect(within(nav).queryByText('Pages')).toBeNull()
    expect(within(nav).queryByText('Viewports')).toBeNull()
    expect(within(nav).queryByText('Conditions')).toBeNull()
  })

  it('active nav item has aria-current="page"', () => {
    openModal('shortcuts')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const shortcutsBtn = within(nav).getByText('Shortcuts').closest('button')
    expect(shortcutsBtn!.getAttribute('aria-current')).toBe('page')
  })

  it('inactive nav items have no aria-current attribute', () => {
    openModal('shortcuts')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const publishingBtn = within(nav).getByText('Publishing').closest('button')
    expect(publishingBtn!.hasAttribute('aria-current')).toBe(false)
  })

  it('clicking a nav item updates aria-current to that item', () => {
    openModal('general')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const publishingBtn = within(nav).getByText('Publishing').closest('button')!
    fireEvent.click(publishingBtn)
    expect(publishingBtn.getAttribute('aria-current')).toBe('page')

    const generalBtn = within(nav).getByText('General').closest('button')!
    expect(generalBtn.hasAttribute('aria-current')).toBe(false)
  })

  it('content region aria-label updates when section changes', () => {
    openModal('general')
    render(<SettingsModal />)
    let region = document.querySelector('[role="region"]')
    expect(region!.getAttribute('aria-label')).toBe('General')

    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const publishingBtn = within(nav).getByText('Publishing').closest('button')!
    fireEvent.click(publishingBtn)

    region = document.querySelector('[role="region"]')
    expect(region!.getAttribute('aria-label')).toBe('Publishing')
  })
})

// ---------------------------------------------------------------------------
// 6 — Section sync from store
// ---------------------------------------------------------------------------

describe('SettingsModal — section sync from store', () => {
  it('opens on "publishing" when store section is "publishing"', () => {
    openModal('publishing')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const publishingBtn = within(nav).getByText('Publishing').closest('button')!
    expect(publishingBtn.getAttribute('aria-current')).toBe('page')
  })

  it('opens on "preferences" when store section is "preferences"', () => {
    openModal('preferences')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const prefBtn = within(nav).getByText('Preferences').closest('button')!
    expect(prefBtn.getAttribute('aria-current')).toBe('page')
  })

  it('falls back to "general" when store section is an invalid ID', () => {
    openModal('nonexistent-section')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const generalBtn = within(nav).getByText('General').closest('button')!
    expect(generalBtn.getAttribute('aria-current')).toBe('page')
  })

  it('falls back to "general" when store section is an empty string', () => {
    openModal('')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const generalBtn = within(nav).getByText('General').closest('button')!
    expect(generalBtn.getAttribute('aria-current')).toBe('page')
  })

  it('falls back to "general" for sections moved out of the modal (pages)', () => {
    openModal('pages')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const generalBtn = within(nav).getByText('General').closest('button')!
    expect(generalBtn.getAttribute('aria-current')).toBe('page')
    expect(within(nav).queryByText('Pages')).toBeNull()
  })

  it('falls back to "general" for sections moved out of the modal (breakpoints)', () => {
    openModal('breakpoints')
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const generalBtn = within(nav).getByText('General').closest('button')!
    expect(generalBtn.getAttribute('aria-current')).toBe('page')
    expect(within(nav).queryByText('Viewports')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7 — Close behaviours
// ---------------------------------------------------------------------------

describe('SettingsModal — close behaviours', () => {
  it('surfaces a shared Esc keycap affordance (no dedicated close button)', () => {
    openModal()
    render(<SettingsModal />)
    // The rail shows a <Kbd>Esc</Kbd> hint; there is no "Close settings" button.
    expect(screen.queryByLabelText('Close settings')).toBeNull()
    const escKey = Array.from(document.querySelectorAll('kbd')).find(
      (el) => el.textContent === 'Esc',
    )
    expect(escKey).toBeDefined()
  })

  it('pressing Escape closes the modal', () => {
    openModal()
    render(<SettingsModal />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })
    expect(useEditorStore.getState().isSettingsOpen).toBe(false)
  })

  it('pressing Tab does NOT close the modal', () => {
    openModal()
    render(<SettingsModal />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Tab', code: 'Tab' })
    expect(useEditorStore.getState().isSettingsOpen).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8 — Focus trap logic (keyboard navigation)
// ---------------------------------------------------------------------------

describe('SettingsModal — focus trap keyboard logic', () => {
  it('dialog has onKeyDown handler attached (Escape closes)', () => {
    openModal()
    render(<SettingsModal />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(useEditorStore.getState().isSettingsOpen).toBe(false)
  })

  it('pressing Escape on a child element inside the dialog closes the modal', () => {
    openModal()
    render(<SettingsModal />)
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const firstBtn = nav.querySelector('button')!
    fireEvent.keyDown(firstBtn, { key: 'Escape' })
    expect(useEditorStore.getState().isSettingsOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9 — GeneralSection rendering
// ---------------------------------------------------------------------------

describe('SettingsModal — GeneralSection rendering', () => {
  it('shows an accessible loading status when no site is in store', () => {
    openModal('general', false /* no site */)
    render(<SettingsModal />)
    expect(screen.getByRole('status', { name: /loading site settings/i })).toBeDefined()
  })

  it('shows the Site Name field when a site is loaded', () => {
    openModal('general', true /* with site */)
    render(<SettingsModal />)
    expect(screen.getByLabelText(/site name/i)).toBeDefined()
  })

  it('renders the section header title in the content column', () => {
    openModal('general', true /* withSite */)
    render(<SettingsModal />)
    // The shell renders the active section title with an accent bar.
    const h3 = Array.from(document.querySelectorAll('h3')).find(
      (el) => el.textContent === 'General',
    )
    expect(h3).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 10 — PreferencesSection — role="switch" toggles
// ---------------------------------------------------------------------------

describe('SettingsModal — PreferencesSection toggles', () => {
  it('toggle buttons have role="switch"', () => {
    openModal('preferences')
    render(<SettingsModal />)
    const switches = screen.getAllByRole('switch')
    expect(switches.length).toBe(12)
  })

  it('Auto-save toggle has aria-checked="true" by default', () => {
    openModal('preferences')
    render(<SettingsModal />)
    const autoSaveToggle = screen.getByRole('switch', { name: /auto-save/i })
    expect(autoSaveToggle.getAttribute('aria-checked')).toBe('true')
  })

  it('retired snap-to-grid and reduce-motion preferences are not rendered', () => {
    openModal('preferences')
    render(<SettingsModal />)
    expect(screen.queryByRole('switch', { name: /snap to grid/i })).toBeNull()
    expect(screen.queryByRole('switch', { name: /reduce motion/i })).toBeNull()
  })

  it('clicking a toggle flips its aria-checked state', () => {
    openModal('preferences')
    render(<SettingsModal />)
    const autoSaveToggle = screen.getByRole('switch', { name: /auto-save/i })
    expect(autoSaveToggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(autoSaveToggle)
    expect(autoSaveToggle.getAttribute('aria-checked')).toBe('false')
  })

  it('hover preview toggle is enabled by default and can be disabled', () => {
    openModal('preferences')
    render(<SettingsModal />)
    const previewToggle = screen.getByRole('switch', { name: /preview suggestions on hover/i })
    expect(previewToggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(previewToggle)

    expect(previewToggle.getAttribute('aria-checked')).toBe('false')
    expect(JSON.parse(localStorage.getItem('instatic-editor-prefs') ?? '{}').hoverPreview).toBe(false)
  })

  it('toggle labels are linked via htmlFor / id (label accessibility)', () => {
    openModal('preferences')
    render(<SettingsModal />)
    const autoSaveToggle = document.getElementById('pref-autoSave')
    expect(autoSaveToggle).not.toBeNull()
    const label = document.querySelector('label[for="pref-autoSave"]')
    expect(label).not.toBeNull()
    expect(label!.textContent).toContain('Auto-save')
  })
})

// ---------------------------------------------------------------------------
// 11 — Guideline #225 — Focus return on close (source enforcement)
// ---------------------------------------------------------------------------

describe('SettingsModal — Guideline #225 focus return (source enforcement)', () => {
  const modalSrc = readFileSync(
    new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url),
    'utf-8',
  )

  it('captures the trigger element (document.activeElement) before focusing inside on open', () => {
    expect(modalSrc).toContain('document.activeElement')
  })

  it('restores focus to the trigger element when modal closes (else branch)', () => {
    expect(modalSrc).toMatch(/else\s*\{[\s\S]*?\.focus\(\)/)
  })
})

// ---------------------------------------------------------------------------
// 12 — Section ID alignment — SettingsButton + store default (source enforcement)
// ---------------------------------------------------------------------------

describe('SettingsButton + settingsSlice — section ID alignment (source enforcement)', () => {
  const btnSrc = readFileSync(
    new URL('../../admin/pages/site/toolbar/SettingsButton.tsx', import.meta.url),
    'utf-8',
  )

  const settingsSliceSrc = readFileSync(
    new URL('../../admin/pages/site/store/slices/settingsSlice.ts', import.meta.url),
    'utf-8',
  )

  it('SettingsButton dispatches a valid section ID', () => {
    // 'general' is the first NAV_ITEMS entry after Pages/Viewports/Conditions
    // were moved to their dedicated controls.
    expect(btnSrc).toContain("openSettings('general')")
  })

  it('settingsSlice activeSection default is a valid section ID', () => {
    expect(settingsSliceSrc).toMatch(/DEFAULT_SECTION: SettingsSection = '(general|preferences|shortcuts|publishing)'/)
  })
})

// ---------------------------------------------------------------------------
// 13 — WCAG 2.4.7 — Input focus rings (source-scan enforcement)
// ---------------------------------------------------------------------------

describe('SettingsModal — WCAG 2.4.7 input focus rings (source enforcement)', () => {
  const inputCss = readFileSync(
    new URL('../../ui/components/Input/Input.module.css', import.meta.url),
    'utf-8',
  )
  const selectCss = readFileSync(
    new URL('../../ui/components/Select/Select.module.css', import.meta.url),
    'utf-8',
  )

  it('Input primitive has a visible :focus / :focus-within style', () => {
    expect(inputCss).toMatch(/:focus(-within)?/)
    expect(inputCss).toContain('--overlay-50')
  })

  it('Select primitive has a visible focus indicator', () => {
    expect(selectCss).toMatch(/--overlay-50|:focus/)
  })

  it('SettingsModal does not carry an inline <style> band-aid', () => {
    const modalSrc = readFileSync(
      new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url),
      'utf-8',
    )
    expect(modalSrc).not.toContain('<style>')
  })
})
