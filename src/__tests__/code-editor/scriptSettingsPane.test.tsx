import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CodeEditorPanel } from '@site/code-editor'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'

afterEach(cleanup)

function resetStore() {
  const home = makePage({ id: 'page-home', title: 'Home', slug: 'index' })
  const packageJson = {
    dependencies: { 'canvas-confetti': '^1.9.3' },
    devDependencies: {},
  }
  const runtime = normalizeSiteRuntimeConfig(undefined)

  useEditorStore.setState({
    site: makeSite({
      pages: [home],
      packageJson,
      runtime,
      files: [{
        id: 'script-1',
        path: 'src/scripts/celebrate.ts',
        type: 'script',
        content: `import confetti from 'canvas-confetti'`,
        createdAt: 1,
        updatedAt: 1,
      }],
    }),
    packageJson,
    siteRuntime: runtime,
    activePageId: 'page-home',
    activeEditorFileId: 'script-1',
    activeMediaAssetPreview: null,
    codeEditorPanelOpen: true,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

describe('Script runtime settings pane', () => {
  it('keeps many problems bounded and collapses to the live error count', () => {
    const diagnostics = Array.from({ length: 12 }, (_, index) => ({
      code: `runtime-error-${index}`,
      severity: 'error' as const,
      message: `Problem ${index + 1}: ${'long diagnostic details '.repeat(8)}`,
      path: 'src/scripts/celebrate.ts',
      line: index + 1,
      column: 4,
    }))

    render(<CodeEditorPanel runtimeValidation={{ status: 'valid', diagnostics }} />)

    const problems = screen.getByRole('region', { name: 'Script problems' })
    expect(screen.getByText('12 errors')).toBeDefined()
    expect(problems.querySelectorAll('li')).toHaveLength(12)

    const minimize = screen.getByRole('button', { name: 'Minimize Problems' })
    expect(minimize.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(minimize)

    expect(screen.getByText('12 errors')).toBeDefined()
    expect(problems.querySelectorAll('li')).toHaveLength(0)
    const expand = screen.getByRole('button', { name: 'Expand Problems' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(expand)
    expect(problems.querySelectorAll('li')).toHaveLength(12)
  })

  it('renders next to active script files and updates runtime config', () => {
    render(<CodeEditorPanel />)

    expect(screen.getByLabelText('Script runtime settings')).toBeDefined()
    expect(screen.getByText('Runtime')).toBeDefined()
    expect(screen.getByText('canvas-confetti')).toBeDefined()

    fireEvent.click(screen.getByRole('switch', { name: 'Run in canvas' }))
    expect(useEditorStore.getState().siteRuntime.scripts['script-1'].runInCanvas).toBe(false)

    fireEvent.change(screen.getByRole('combobox', { name: 'Script format' }), {
      target: { value: 'classic' },
    })
    expect(useEditorStore.getState().siteRuntime.scripts['script-1'].format).toBe('classic')

    fireEvent.change(screen.getByRole('combobox', { name: 'Script placement' }), {
      target: { value: 'head' },
    })
    expect(useEditorStore.getState().siteRuntime.scripts['script-1'].placement).toBe('head')

    fireEvent.change(screen.getByRole('combobox', { name: 'Script timing' }), {
      target: { value: 'idle' },
    })
    expect(useEditorStore.getState().siteRuntime.scripts['script-1'].timing).toBe('idle')

    // Switching to "Specific pages" starts with an empty selection, then each
    // page chip toggles membership — no more lossy "current page" snapshot.
    fireEvent.change(screen.getByRole('combobox', { name: 'Script scope' }), {
      target: { value: 'pages' },
    })
    expect(useEditorStore.getState().siteRuntime.scripts['script-1'].scope).toEqual({
      type: 'pages',
      pageIds: [],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(useEditorStore.getState().siteRuntime.scripts['script-1'].scope).toEqual({
      type: 'pages',
      pageIds: ['page-home'],
    })

    fireEvent.change(screen.getByLabelText('Script priority'), {
      target: { value: '7' },
    })
    expect(useEditorStore.getState().siteRuntime.scripts['script-1'].priority).toBe(7)
  })

  it('does not run package import analysis for classic scripts', () => {
    useEditorStore.setState((state) => ({
      siteRuntime: {
        ...state.siteRuntime,
        scripts: {
          ...state.siteRuntime.scripts,
          'script-1': {
            ...state.siteRuntime.scripts['script-1'],
            format: 'classic',
          },
        },
      },
    }) as Parameters<typeof useEditorStore.setState>[0])

    render(<CodeEditorPanel />)

    expect(screen.queryByText('canvas-confetti')).toBeNull()
  })

  it('does not render for stylesheets', () => {
    useEditorStore.setState((state) => ({
      site: state.site
        ? {
            ...state.site,
            files: [{
              id: 'style-1',
              path: 'src/styles/theme.css',
              type: 'style',
              content: '',
              createdAt: 1,
              updatedAt: 1,
            }],
          }
        : state.site,
      activeEditorFileId: 'style-1',
    }) as Parameters<typeof useEditorStore.setState>[0])

    render(<CodeEditorPanel />)

    expect(screen.queryByLabelText('Script runtime settings')).toBeNull()
  })
})
