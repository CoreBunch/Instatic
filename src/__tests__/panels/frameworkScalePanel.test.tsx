import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { SpacingTab } from '@site/panels/SpacingPanel'
import { TypographyTab } from '@site/panels/TypographyPanel'
import { useEditorStore } from '@site/store/store'
import type { FontEntry } from '@core/fonts'
import { makeSite } from '../fixtures'

const INTER_FONT: FontEntry = {
  id: 'font-inter',
  source: 'google',
  family: 'Inter',
  variants: ['400'],
  subsets: ['latin'],
  files: [
    { variant: '400', subset: 'latin', path: '/uploads/fonts/inter/400-latin.woff2', format: 'woff2' },
  ],
  category: 'Sans Serif',
  createdAt: 1,
  updatedAt: 1,
}

// The scale tabs are chrome-free; wrap them in testid containers so the
// existing scoping queries keep working.
function TypographyPanel() {
  return (
    <div data-testid="typography-panel">
      <TypographyTab />
    </div>
  )
}
function SpacingPanel() {
  return (
    <div data-testid="spacing-panel">
      <SpacingTab />
    </div>
  )
}

function resetStore() {
  useEditorStore.setState({
    site: makeSite(),
    activePageId: 'page-1',
    frameworkPanelOpen: true,
    frameworkPanelTab: 'typography',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)
afterEach(cleanup)

describe('FrameworkScalePanel', () => {
  it('keeps scale creation in the section controls', () => {
    useEditorStore.getState().createFrameworkTypographyGroup()
    useEditorStore.getState().createFrameworkSpacingGroup()

    render(
      <>
        <TypographyPanel />
        <SpacingPanel />
      </>,
    )

    const typographyPanel = screen.getByTestId('typography-panel')
    const spacingPanel = screen.getByTestId('spacing-panel')
    const typographyScalePicker = within(typographyPanel).getByRole('group', {
      name: 'Typography scales',
    })
    const spacingScalePicker = within(spacingPanel).getByRole('group', {
      name: 'Spacing scales',
    })

    expect(within(typographyScalePicker).getByRole('button', { name: 'Add typography scale' })).toBeDefined()
    expect(within(spacingScalePicker).getByRole('button', { name: 'Add spacing scale' })).toBeDefined()
  })

  it('uses the shared empty state when installed fonts have no font tokens', () => {
    useEditorStore.setState({
      site: makeSite({
        settings: {
          shortcuts: {},
          fonts: {
            items: [INTER_FONT],
            tokens: [],
          },
        },
      }),
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<TypographyPanel />)

    const typographyPanel = screen.getByTestId('typography-panel')
    const fontTokenEmptyText = within(typographyPanel).getByText('No font tokens yet.')
    const emptyState = fontTokenEmptyText.closest('[role="status"]')

    expect(emptyState).toBeTruthy()
    expect(within(emptyState as HTMLElement).getByRole('button', { name: 'Create token' })).toBeTruthy()
    expect(within(typographyPanel).getAllByRole('button', { name: 'Create token' })).toHaveLength(1)
  })
})
