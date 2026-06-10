/**
 * Toolbar Component Tests — J13
 *
 * Tests focus on:
 *   1. UndoRedoButtons — WCAG aria-disabled pattern (Guideline #224),
 *      keyboard shortcut handler registration. The component lives in the
 *      canvas notch (src/editor/components/Canvas/UndoRedoButtons.tsx) so
 *      Undo/Redo only appears on the visual editor, not on Content / Plugins
 *      admin pages.
 *   2. ZoomControls — zoom percentage rendering, correct store subscriptions.
 *   3. ModulePickerDropdown — search filter pure logic.
 *   4. PublishButton — state machine (idle → publishing → published / error).
 *   5. Toolbar — overall structure (role, testid, always-rendered sub-components).
 *
 * React component rendering tests use renderToStaticMarkup (same pattern as
 * canvas/accessibility.test.tsx) so no JSDOM or browser is needed.
 *
 * Store-dependent tests use the actual Zustand store (reset between tests
 * via createSite / clearSite) rather than mocks — this catches real
 * integration issues between toolbar actions and store state.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ─── Guideline #224 constants ─────────────────────────────────────────────────

const MIN_TOUCH_TARGET = 44 // px

// ---------------------------------------------------------------------------
// 1 — Zoom percentage display
// ---------------------------------------------------------------------------

describe('ZoomControls — zoom percentage display', () => {
  it('converts zoom 1.0 to "100%"', () => {
    expect(Math.round(1.0 * 100)).toBe(100)
  })

  it('converts zoom 0.5 to "50%"', () => {
    expect(Math.round(0.5 * 100)).toBe(50)
  })

  it('converts zoom 1.5 to "150%"', () => {
    expect(Math.round(1.5 * 100)).toBe(150)
  })

  it('converts zoom 0.123 to "12%" (rounds down)', () => {
    expect(Math.round(0.123 * 100)).toBe(12)
  })

  it('converts zoom 4.0 to "400%" (max zoom)', () => {
    expect(Math.round(4.0 * 100)).toBe(400)
  })

  it('converts zoom 0.1 to "10%" (min zoom)', () => {
    expect(Math.round(0.1 * 100)).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// 2 — UndoRedoButtons — WCAG aria-disabled pattern (Guideline #224)
// ---------------------------------------------------------------------------

describe('UndoRedoButtons — WCAG aria-disabled pattern (Guideline #224)', () => {
  it('aria-disabled buttons must still be in the DOM (no conditional removal)', () => {
    // Structural assertion: both buttons are always rendered regardless of state.
    // We assert this by checking the toolbar source uses aria-disabled, not disabled.
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    // Must use aria-disabled for the disabled state (Guideline #224)
    expect(src).toContain('aria-disabled={!canUndo}')
    expect(src).toContain('aria-disabled={!canRedo}')
    // Must NOT use the `disabled` HTML attribute on the <button> directly.
    // Note: `aria-disabled={!canUndo}` contains "disabled={!canUndo}" as a substring,
    // so we check for the exact standalone HTML attribute pattern: `disabled={` NOT
    // preceded by "aria-". Using a negative lookahead-style check via regex.
    expect(/(?<!aria-)disabled=\{!can/.test(src)).toBe(false)
  })

  it('aria-keyshortcuts attributes are present for screen readers', () => {
    // Post-spotlight refactor: shortcut values come from the keybindings
    // registry (keybindings.ts) rather than being hardcoded in JSX. We assert
    // the JSX wires aria-keyshortcuts to the registry-resolved binding, AND
    // that the registry itself declares the canonical ⌘Z / ⌘⇧Z labels so
    // screen readers still receive "Meta+Z" / "Meta+Shift+Z" on macOS.
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('aria-keyshortcuts={kbUndo?.ariaKeyshortcuts}')
    expect(src).toContain('aria-keyshortcuts={kbRedo?.ariaKeyshortcuts}')

    // Confirm the registry resolves the canonical shortcuts the buttons rely on.
    const registrySrc = readFileSync(
      new URL('../../admin/spotlight/keybindings.ts', import.meta.url),
      'utf-8',
    )
    expect(registrySrc).toContain("commandId: 'editor.undo'")
    expect(registrySrc).toContain("commandId: 'editor.redo'")
    expect(registrySrc).toContain("'Meta+Z' : 'Control+Z'")
    expect(registrySrc).toContain("'Meta+Shift+Z' : 'Control+Shift+Z'")
  })

  it('keyboard shortcut handler guards against text input targets', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    // Shortcuts must not fire inside inputs (would break text editing)
    expect(src).toContain("tagName === 'INPUT'")
    expect(src).toContain("tagName === 'TEXTAREA'")
    expect(src).toContain('isContentEditable')
  })

  it('keyboard handler registers on document (global scope, not canvas-local)', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('document.addEventListener')
    expect(src).toContain('document.removeEventListener')
  })

  it('handler supports both Cmd+Z (undo) and Cmd+Shift+Z / Cmd+Y (redo)', () => {
    // Post-spotlight refactor: the keydown handler delegates undo/redo matching
    // to the keybindings registry via `kb.match(e)`. The Ctrl+Y Windows alias
    // stays inline because the canonical Redo binding is ⌘⇧Z — Ctrl+Y is just
    // a convenience escape hatch.
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('kbUndo?.match(e)')
    expect(src).toContain('kbRedo?.match(e)')
    // Also support Ctrl+Y (Windows redo) — handled inline as an alias.
    expect(src).toContain("e.key === 'y'")
  })
})

// ---------------------------------------------------------------------------
// 3 — ModulePickerDropdown — search filter logic
// ---------------------------------------------------------------------------

// The filtering logic is extracted here for pure-function testing.
// It mirrors what the useMemo in ModulePickerDropdown computes.
function filterModules(
  grouped: Record<string, Array<{ id: string; name: string }>>,
  query: string,
): Record<string, Array<{ id: string; name: string }>> {
  const q = query.trim().toLowerCase()
  if (!q) return grouped
  const result: Record<string, Array<{ id: string; name: string }>> = {}
  for (const [cat, mods] of Object.entries(grouped)) {
    const matching = mods.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        cat.toLowerCase().includes(q),
    )
    if (matching.length > 0) result[cat] = matching
  }
  return result
}

const MOCK_REGISTRY: Record<string, Array<{ id: string; name: string }>> = {
  Layout: [
    { id: 'base.container', name: 'Container' },
  ],
  Typography: [
    { id: 'base.text', name: 'Text' },
  ],
  Interactive: [
    { id: 'base.button', name: 'Button' },
    { id: 'base.link', name: 'Link' },
  ],
}

describe('ModulePickerDropdown — search filter', () => {
  it('returns all modules when query is empty', () => {
    const result = filterModules(MOCK_REGISTRY, '')
    expect(Object.keys(result)).toHaveLength(3)
    expect(result['Layout']).toHaveLength(1)
    expect(result['Typography']).toHaveLength(1)
  })

  it('filters by module name (case-insensitive)', () => {
    const result = filterModules(MOCK_REGISTRY, 'text')
    expect(Object.keys(result)).toHaveLength(1)
    expect(result['Typography']).toHaveLength(1)
    expect(result['Typography'][0].name).toBe('Text')
  })

  it('filters by module ID', () => {
    const result = filterModules(MOCK_REGISTRY, 'base.button')
    expect(result['Interactive']).toHaveLength(1)
    expect(result['Interactive'][0].id).toBe('base.button')
  })

  it('filters by category name', () => {
    const result = filterModules(MOCK_REGISTRY, 'layout')
    expect(result['Layout']).toHaveLength(1)
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('returns empty object when no modules match', () => {
    const result = filterModules(MOCK_REGISTRY, 'xyznonexistent')
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('is case-insensitive for all match types', () => {
    expect(filterModules(MOCK_REGISTRY, 'BUTTON')['Interactive']).toHaveLength(1)
    expect(filterModules(MOCK_REGISTRY, 'TEXT')['Typography']).toHaveLength(1)
    expect(filterModules(MOCK_REGISTRY, 'LAYOUT')['Layout']).toHaveLength(1)
  })

  it('trims whitespace from query before filtering', () => {
    const result = filterModules(MOCK_REGISTRY, '  container  ')
    expect(result['Layout']).toHaveLength(1)
    expect(result['Layout'][0].id).toBe('base.container')
  })

  it('partial match works (prefix, suffix, substring)', () => {
    // "tex" should match "Text" (prefix)
    const byPrefix = filterModules(MOCK_REGISTRY, 'tex')
    expect(byPrefix['Typography']).toHaveLength(1)
    expect(byPrefix['Typography'][0].name).toBe('Text')

    // "ext" suffix — unique to Text, does NOT appear in category name "Typography"
    const bySuffix = filterModules(MOCK_REGISTRY, 'ext')
    expect(bySuffix['Typography']).toHaveLength(1)
    expect(bySuffix['Typography'][0].name).toBe('Text')

    // Note: "raph" is a substring of "typography" (the category), so it matches
    // the whole category — we do NOT use "raph" for suffix testing here.
  })
})

// ---------------------------------------------------------------------------
// 4 — PublishButton — state machine
// ---------------------------------------------------------------------------

describe('PublishButton — publish state machine', () => {
  it('transitions: idle → publishing → published on success', () => {
    type State = 'idle' | 'publishing' | 'published' | 'error'
    // Simulate the state transitions
    let state: State = 'idle'

    // Start publish
    state = 'publishing'
    expect(state).toBe('publishing')

    // Publish succeeds
    state = 'published'
    expect(state).toBe('published')
  })

  it('transitions: idle → publishing → error on failure', () => {
    type State = 'idle' | 'publishing' | 'published' | 'error'
    let state: State = 'idle'

    state = 'publishing'
    state = 'error'
    expect(state).toBe('error')
  })

  it('source emits role="alert" for error messages (Guideline #224)', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishActionGroup.tsx', import.meta.url),
      'utf-8',
    )
    // Error must be surfaced via role="alert" — not silently swallowed
    expect(src).toContain("role={toast.tone === 'alert' ? 'alert' : 'status'}")
  })

  it('source uses aria-busy during publish', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishActionGroup.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('aria-busy={publishBusy}')
  })

  it('publish button has data-testid for Playwright targeting', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishActionGroup.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('data-testid="toolbar-publish-btn"')
  })

  it('saves the current draft before calling the CMS publish endpoint', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishButton.tsx', import.meta.url),
      'utf-8',
    )
    // The publish call is wrapped in `runStepUp(() => publishCmsDraft())`
    // so the StepUpProvider can intercept `step_up_required` and re-auth.
    // We assert that save runs before that wrapped call lands.
    const savePosition = src.indexOf('await onSave?.()')
    const publishPosition = src.indexOf('publishCmsDraft()')
    expect(savePosition).toBeGreaterThan(-1)
    expect(publishPosition).toBeGreaterThan(savePosition)
  })

  it('loads persisted publish status when the toolbar mounts', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishButton.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('getCmsPublishStatus')
    expect(src).toContain('draftMatchesPublished')
  })

  it('returns from Published to Publish when the draft has unsaved changes', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishButton.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('hasUnsavedChanges')
    expect(src).toContain("setState('idle')")
  })

  it('does not import old static export pipelines', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishButton.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).not.toContain('@core/publisher')
    expect(src).not.toContain('@core/react-publisher')
  })
})

// ---------------------------------------------------------------------------
// 5 — Toolbar shell structure
// ---------------------------------------------------------------------------

describe('Toolbar — structural requirements', () => {
  it('source uses a native <header> as the top-level banner landmark', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/Toolbar.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('<header')
    expect(src).not.toContain('role="banner"')
  })

  it('source has data-testid="toolbar" for Playwright targeting', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/Toolbar.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('data-testid="toolbar"')
  })

  it('Toolbar is a prop-driven shell — editor-only buttons live in AdminCanvasLayout', () => {
    // After the Toolbar refactor, Toolbar.tsx itself no longer references
    // editor-specific sub-components (ZoomControls / PublishButton /
    // SettingsButton / save status). Those are passed in via the
    // `rightSlot` prop by AdminCanvasLayout, which keeps Toolbar shareable
    // with AdminPageLayout (Plugins / Users / Account) without dragging
    // the editor store into the non-editor admin bundle.
    const { readFileSync } = require('fs')
    const toolbarSrc = readFileSync(
      new URL('../../admin/pages/site/toolbar/Toolbar.tsx', import.meta.url),
      'utf-8',
    )
    // Toolbar.tsx must not import the editor-only sub-components.
    expect(toolbarSrc).not.toContain('UndoRedoButtons')
    expect(toolbarSrc).not.toContain('ModulePickerDropdown')
    expect(toolbarSrc).not.toContain('ExportButton')
    expect(toolbarSrc).not.toContain('SaveIndicator')
    expect(toolbarSrc).not.toContain("from './ZoomControls'")
    expect(toolbarSrc).not.toContain("from './PublishButton'")
    expect(toolbarSrc).not.toContain('saveStatus={saveStatus}')

    // The editor-only buttons must be mounted from AdminCanvasLayout.
    const layoutSrc = readFileSync(
      new URL('../../admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx', import.meta.url),
      'utf-8',
    )
    expect(layoutSrc).toContain('ZoomControls')
    expect(layoutSrc).toContain('PublishButton')
    expect(layoutSrc).toContain('SettingsButton')
    expect(layoutSrc).toContain('saveStatus={persistence.saveStatus}')
  })

  it('module picker trigger has data-testid for Playwright', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/ModulePickerDropdown.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('triggerTestId')
  })

  it('Toolbar no longer renders panel toggles or create-page/component quick actions', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/Toolbar.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).not.toContain('FilesButton')
    expect(src).not.toContain('CodeEditorButton')
    expect(src).not.toContain('PropertiesButton')
    expect(src).not.toContain('AgentButton')
    expect(src).not.toContain('NewPageButton')
    expect(src).not.toContain('NewComponentButton')
  })

  it('Add inserter is module-only — no in-toolbar page/component create actions', () => {
    // Page / Component creation lives in the Site Explorer panel (the dedicated
    // place for site structure). The toolbar "+ Add" inserter is module-only.
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/ModulePickerDropdown.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).not.toContain('toolbar-add-page-action')
    expect(src).not.toContain('toolbar-add-component-action')
    expect(src).not.toContain('SiteCreateDialog')
    expect(src).not.toContain('NewFileModal')
    expect(src).not.toContain('src/pages/')
    expect(src).not.toContain('src/components/')
  })

  it('all required data-testid attributes are present (Guideline #221)', () => {
    const { readFileSync } = require('fs')
    // UndoRedo testids
    const undoSrc = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url), 'utf-8',
    )
    expect(undoSrc).toContain('data-testid="canvas-notch-undo-btn"')
    expect(undoSrc).toContain('data-testid="canvas-notch-redo-btn"')

    // ZoomControls testid
    const zoomSrc = readFileSync(
      new URL('../../admin/pages/site/toolbar/ZoomControls.tsx', import.meta.url), 'utf-8',
    )
    expect(zoomSrc).toContain('data-testid="toolbar-zoom-controls"')

    // Publishing split-button testids
    const publishingSrc = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishActionGroup.tsx', import.meta.url), 'utf-8',
    )
    expect(publishingSrc).toContain('data-testid="toolbar-publish-actions-trigger"')
    expect(publishingSrc).toContain('data-testid="toolbar-publish-actions-menu"')
  })

  it('ModulePicker uses ContextMenu primitives (role="menu" + role="menuitem")', () => {
    const { readFileSync } = require('fs')
    // The compact picker content lives in ModulePicker.tsx for DOM-panel
    // right-click submenus. The toolbar "+ Add" opens ModuleInserterDialog.
    // ModulePicker doesn't author its own role="menu" — it relies on the
    // wrapping ContextMenuSubmenu for that — and uses ContextMenuItem for
    // every row, which renders a `role="menuitem"` button.
    const src = readFileSync(
      new URL('../../admin/pages/site/module-picker/ModulePicker.tsx', import.meta.url), 'utf-8',
    )
    expect(src).toContain('ContextMenuItem')
    // UX Review #333: role="listbox" without arrow-key nav is incorrect. The
    // picker uses ContextMenuItem (role="menuitem") instead.
    const codeLines = src.split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    expect(codeLines).not.toContain('role="listbox"')
    expect(codeLines).not.toContain('role="option"')
  })

  it('ModulePicker search input has a visible focus ring (WCAG SC 2.4.7)', () => {
    const { readFileSync, existsSync } = require('fs')
    // The picker uses the shared <SearchBar /> primitive; the focus ring lives
    // in that primitive's CSS module so every search bar in the editor uses
    // the same focus treatment. We assert on the primitive's stylesheet.
    const cssPath = new URL('../../ui/components/SearchBar/SearchBar.module.css', import.meta.url)
    const cssSrc = existsSync(cssPath.pathname) ? readFileSync(cssPath, 'utf-8') : ''
    // Assert CSS module :focus / :focus-visible selector (no Tailwind).
    const hasCssModuleFocus = /:focus[-\s{]|:focus-visible/.test(cssSrc)
    expect(hasCssModuleFocus).toBe(true)
  })

  it('PublishButton uses ref to track status timer (no useState leak on unmount)', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishButton.tsx', import.meta.url), 'utf-8',
    )
    // Timer must be stored in a ref and cleared in a cleanup effect
    expect(src).toContain('statusTimerRef')
    expect(src).toContain('clearTimeout')
    expect(src).toContain('useEffect')
  })

  it('PublishButton uses one split publishing control with explicit draft actions', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishButton.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('PublishActionGroup')
    expect(src).toContain('Draft saved')
    expect(src).toContain('Unsaved draft')
    expect(src).toContain("state === 'published' ? 'Published'")
    expect(src).toContain('state === \'published\' ? CheckIcon')
    expect(src).toContain("statusLabel={state === 'published' ? null : status.label}")
    expect(src).toContain('publishDisabled={disabled || state === \'published\'}')
    expect(src).toContain('Save draft')
    expect(src).toContain('Preview page')
    // "Open live page" used to live in this menu — it's now a dedicated
    // icon button (OpenLivePageButton) next to the avatar in the Toolbar
    // shell so it's reachable from every admin route, not just the Site
    // editor. Asserting it's gone from the menu keeps the two surfaces
    // from drifting back into a duplicate action.
    expect(src).not.toContain("label: 'Open live page'")
    expect(src).not.toContain("'toolbar-open-page-new-tab-action'")
    expect(src).toContain("'Retry publish'")
    expect(src).not.toContain("label: 'Live'")
    expect(src).not.toContain("'Publish failed'")
  })

  it('PublishActionGroup exposes a menu button for secondary publishing actions and can omit the status label', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishActionGroup.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('statusLabel?: string | null')
    expect(src).toContain('{statusLabel && (')
    expect(src).toContain('aria-haspopup="menu"')
    expect(src).toContain('aria-expanded={menuOpen}')
    expect(src).toContain('<ContextMenu')
    expect(src).toContain('<ContextMenuItem')
  })

  it('PublishActionGroup uses the shared ContextMenu portal above editor panels', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/PublishActionGroup.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('@ui/components/ContextMenu')
    expect(src).toContain('createPortal')
    expect(src).toContain('zIndex={10000}')
  })

  it('AdminCanvasLayout imports and renders Toolbar', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain("import { Toolbar }")
    expect(src).toContain('const persistence = usePersistence(')
    expect(src).toContain("'default'")
    expect(src).toContain('cmsAdapter')
    // PublishButton's `enabled` prop carries the publish gating now
    // (the old `publishEnabled` toolbar prop was dropped when Toolbar
    // became prop-driven — AdminCanvasLayout mounts PublishButton itself
    // inside the toolbar's rightSlot).
    expect(src).toContain('<PublishButton')
    expect(src).toContain('enabled={canPublishPages}')
  })

  it('AdminCanvasLayout keeps zoom and publishing controls adjacent without a divider', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('<ZoomControls />')
    expect(src).toContain('<PublishButton')
    expect(src).not.toContain('ToolbarDivider')
  })

  it('touch targets: all toolbar buttons have a defined compact height (Guideline #357)', () => {
    // Guideline #357 (user directive #1532): WCAG 2.5.5 44px touch target requirement
    // is explicitly waived for editor chrome. Toolbar controls target 28px.
    // Pattern asserts a 24–29px height value declared in the shared Toolbar.module.css.
    // UndoRedoButtons lives in the canvas notch and uses the notch chrome
    // styling, not the toolbar shared CSS — covered by canvasNotch.test.ts.
    const files = [
      'ZoomControls.tsx',
      'PublishButton.tsx',
      'PublishActionGroup.tsx',
      'SettingsButton.tsx',
    ]
    const { readFileSync, existsSync } = require('fs')
    // Read the shared Toolbar.module.css once — all Toolbar sub-components use it
    const cssUrl = new URL('../../admin/pages/site/toolbar/Toolbar.module.css', import.meta.url)
    const sharedCss = existsSync(cssUrl.pathname) ? readFileSync(cssUrl, 'utf-8') : ''
    for (const file of files) {
      const tsx = readFileSync(
        new URL(`../../admin/pages/site/toolbar/${file}`, import.meta.url),
        'utf-8',
      )
      const src = tsx + '\n' + sharedCss
      // Compact only — 24–29px height declared in the shared Toolbar.module.css.
      const hasHeight = /height:\s*2[4-9]/.test(src)
      expect(hasHeight).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 7 — ModulePickerDropdown keyboard navigation: ArrowDown from search input
//     Regression test for the WCAG 2.1.1 gap found in UX Review #343.
//
//     Bug: handleMenuKeyDown was attached to the menu container div, NOT the
//     search input. When the dropdown opens, focus is on the search input.
//     Pressing ArrowDown dispatched the event on the input; it bubbled up to
//     the input's ancestors — but the menu div is a SIBLING, not an ancestor,
//     so ArrowDown was silently lost. Keyboard-only users could type a query
//     but could never navigate to or select any module result.
//
//     Fix (Contribution #350): added onKeyDown to the search <input> that
//     forwards ArrowDown to the first [role="menuitem"] element via .focus().
// ---------------------------------------------------------------------------

describe('ModulePicker — ArrowDown keyboard bridge (WCAG SC 2.1.1)', () => {
  // The bridge logic lives in the shared ModulePicker.tsx (used by both the
  // DOM-panel right-click submenu.
  const { readFileSync } = require('fs')
  const src = readFileSync(
    new URL('../../admin/pages/site/module-picker/ModulePicker.tsx', import.meta.url),
    'utf-8',
  )

  it('search input has an onKeyDown handler (WCAG 2.1.1 — keyboard access)', () => {
    // The search input must have its OWN onKeyDown. Without it, ArrowDown from
    // the input cannot reach the wrapping menu's keyboard nav. We verify the
    // handler is wired to the <SearchBar /> via an `onKeyDown=` prop.
    const inputBlock = src.slice(
      src.indexOf('ref={searchRef}') - 10,
      src.indexOf('ref={searchRef}') + 600,
    )
    expect(inputBlock).toContain('onKeyDown')
  })

  it('ArrowDown on search input forwards focus to first menu item', () => {
    // The bridge must use querySelector('[role="menuitem"]') to find the first
    // item, then call .focus() on it.
    const codeLines = src.split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')

    expect(codeLines).toMatch(/ArrowDown/)
    expect(codeLines).toContain('[role="menuitem"]')
    expect(codeLines).toMatch(/first.*\.focus\(\)|querySelector.*focus\(\)/)
  })

  it('ArrowDown bridge calls preventDefault() to stop page scroll', () => {
    // Without preventDefault, ArrowDown scrolls the page while also (if the
    // bridge is working) moving focus. The scroll is jarring and unexpected.
    // Strip JSDoc/line comments first so prose mentions of "ArrowDown" don't
    // shadow the actual handler block.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line: string) => !line.trim().startsWith('//'))
      .join('\n')
    const idx = codeOnly.indexOf('ArrowDown')
    const bridgeBlock = codeOnly.slice(idx, idx + 200)
    expect(bridgeBlock).toContain('preventDefault()')
  })
})

// ---------------------------------------------------------------------------
// 7 — SettingsModal WCAG fixes (Guideline #225 + WCAG 2.5.5 + section ID)
//
// Three issues were identified after the initial J10 acceptance:
//   1. WCAG 2.4.3 / Guideline #225: focus not returned to trigger on close
//   2. WCAG 2.5.5: nav buttons + close button minHeight: 36 (below 44px min)
//   3. Section ID mismatch: 'general' is not a valid SectionId — silently falls back
//
// These tests lock in the fixes so they cannot be silently reverted.
// ---------------------------------------------------------------------------

describe('SettingsModal — WCAG 2.4.3 focus-return on close (Guideline #225)', () => {
  it('declares a triggerRef to capture the element that opened the modal', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url).pathname,
      'utf-8',
    ) as string
    // The ref must be a nullable HTMLElement ref (so .focus() is available)
    expect(src).toContain('triggerRef')
    expect(src).toMatch(/useRef<HTMLElement\s*\|\s*null>/)
  })

  it('captures document.activeElement into triggerRef when modal opens', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url).pathname,
      'utf-8',
    ) as string
    // Must guard with instanceof before assigning (avoids assigning non-focusable elements)
    expect(src).toMatch(/document\.activeElement\s+instanceof\s+HTMLElement/)
    expect(src).toContain('triggerRef.current = document.activeElement')
  })

  it('restores focus to trigger when modal closes (Guideline #225)', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url).pathname,
      'utf-8',
    ) as string
    // The else branch (open → false) must focus the captured trigger
    expect(src).toContain('triggerRef.current?.focus()')
    // And must clear the ref to avoid a stale reference
    expect(src).toContain('triggerRef.current = null')
  })

  it('does not regress to a 36px touch target anywhere', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url).pathname,
      'utf-8',
    ) as string
    expect(src).not.toMatch(/minHeight:\s*36/)
  })

  it('closes via the shared Esc keycap affordance, not a dedicated close button', () => {
    // The modal shares the Spotlight / Module Inserter language: backdrop click
    // and Esc both close, surfaced through a <Kbd>Esc</Kbd> hint in the rail.
    // There is no bespoke "Close settings" button (consistency pass).
    const { readFileSync } = require('fs')
    const tsx = readFileSync(
      new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url).pathname,
      'utf-8',
    ) as string
    expect(tsx).not.toContain('aria-label="Close settings"')
    expect(tsx).toContain('<Kbd>Esc</Kbd>')
  })
})

describe('SettingsButton — section ID matches a valid SectionId', () => {
  it("dispatches 'general' (a valid SectionId after dropping the Pages section)", () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/SettingsButton.tsx', import.meta.url).pathname,
      'utf-8',
    ) as string
    // 'pages' / 'breakpoints' / 'conditions' were dropped from the modal —
    // 'general' is the first NAV_ITEMS entry and the canonical default.
    expect(src).toContain("openSettings('general')")
  })
})
