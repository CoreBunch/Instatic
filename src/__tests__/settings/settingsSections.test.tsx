/**
 * Settings Sections — Accessibility & Interaction Tests
 *
 * Covers the sections that live in the Settings modal after the Pages,
 * Viewports, and Conditions sections were moved to their dedicated controls
 * (site explorer / canvas context selector). Only General, Shortcuts,
 * Publishing, and Preferences remain — the catalog-driven Preferences and
 * Publishing sections carry the interactive surface worth asserting here.
 *
 * Uses @testing-library/react + happy-dom (GlobalWindow preloaded via setup.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { PreferencesSection } from '@admin/modals/Settings/sections/PreferencesSection'
import { AdminSessionProvider } from '@admin/session'
import type { CmsCurrentUser } from '@core/persistence'
import { PublishingSection } from '@admin/modals/Settings/sections/PublishingSection'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'

// ---------------------------------------------------------------------------
// Store reset helpers
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

beforeEach(resetStore)
afterEach(cleanup)

// ---------------------------------------------------------------------------
// PreferencesSection — catalog-driven rendering
// ---------------------------------------------------------------------------

describe('PreferencesSection — catalog-driven rendering', () => {
  it('auto-renders one switch per boolean catalog entry and excludes retired keys', () => {
    render(<PreferencesSection />)

    // Boolean preferences currently declared in `admin/pages/site/preferences/catalog.ts`:
    //   hoverPreview, godMode (capability-gated; test users are full-access), confirmBeforeDelete,
    //   layersShowIcon, layersShowTag, layersShowClasses,
    //   layersAutoExpandSelected, layersSmoothScroll,
    //   dimInactiveBreakpoints, propertiesSmoothScroll,
    //   propertiesSectionsExpanded,
    //   spotlightTelemetryEnabled  ← Phase 6: opt-in command-usage telemetry
    // Adding/removing a boolean preference is one catalog edit and this
    // assertion updates with it.
    expect(screen.getAllByRole('switch')).toHaveLength(12)
    expect(screen.getByRole('switch', { name: /preview suggestions on hover/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /confirm before deleting/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /show module icon/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /show html tag/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /show class names/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /auto-expand on selection/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /smooth scroll to selected/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /dim inactive viewports/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /smooth scroll on tab change/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /expand style sections by default/i })).toBeDefined()
    expect(screen.getByRole('switch', { name: /track command usage/i })).toBeDefined()
    expect(screen.queryByRole('switch', { name: /snap to grid/i })).toBeNull()
    expect(screen.queryByRole('switch', { name: /reduce motion/i })).toBeNull()
  })

  it('hides capability-gated preferences from users without structure-edit rights', () => {
    // Minimal content-editor user: no site.structure.edit / pages.edit.
    const contentEditor: CmsCurrentUser = {
      id: 'u_content',
      email: 'copy@example.com',
      displayName: 'Copy Editor',
      status: 'active',
      role: {
        id: 'editor',
        slug: 'editor',
        name: 'Editor',
        description: '',
        isSystem: true,
        capabilities: ['site.read', 'content.edit'],
      },
      capabilities: ['site.read', 'content.edit'],
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
      createdAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:00:00.000Z',
    }

    render(
      <AdminSessionProvider user={contentEditor}>
        <PreferencesSection />
      </AdminSessionProvider>,
    )

    expect(screen.queryByRole('switch', { name: /god mode/i })).toBeNull()
    // Ungated preferences still render.
    expect(screen.getByRole('switch', { name: /preview suggestions on hover/i })).toBeDefined()
  })

  it('auto-renders one combobox per select catalog entry', () => {
    render(<PreferencesSection />)
    // Select preferences: theme, density, textScale, defaultBreakpoint
    // (auto-save delay is gone — the collab relay persists continuously)
    const selects = screen.getAllByRole('combobox')
    expect(selects.length).toBe(4)
    expect(screen.getByRole('combobox', { name: /theme/i })).toBeDefined()
    expect(screen.getByRole('combobox', { name: /ui density/i })).toBeDefined()
    expect(screen.getByRole('combobox', { name: /ui text size/i })).toBeDefined()
    expect(screen.getByRole('combobox', { name: /default viewport/i })).toBeDefined()
  })
})

describe('PublishingSection — framework CSS output preferences', () => {
  it('toggles generated framework utility tree-shaking in site settings', () => {
    const site = makeSite()
    useEditorStore.setState({
      site,
      activePageId: site.pages[0].id,
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<PublishingSection />)

    const toggle = screen.getByRole('switch', {
      name: /tree-shake generated framework utilities/i,
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)

    expect(
      useEditorStore.getState().site!.settings.framework?.preferences
        ?.treeShakeGeneratedFrameworkUtilities,
    ).toBe(false)
  })
})
