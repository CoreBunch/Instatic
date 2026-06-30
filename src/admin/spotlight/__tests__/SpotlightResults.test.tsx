import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { SpotlightInternalContext, type SpotlightInternalContextValue } from '../spotlightContext'
import { SpotlightResults } from '../SpotlightResults'
import type { SpotlightOpenState } from '../state'

afterEach(() => {
  cleanup()
  mock.restore()
})

function makeOpenState(highlightedIndex: number): SpotlightOpenState {
  return {
    phase: 'open',
    query: '',
    scopeStack: [{ scopeId: 'root', pendingArgs: {} }],
    highlightedIndex,
    asyncResults: {},
    loadingProviders: new Set(),
    argMode: null,
    pendingConfirm: null,
  }
}

function renderResults(highlightedIndex: number) {
  const context: SpotlightInternalContextValue = {
    state: makeOpenState(highlightedIndex),
    dispatch: () => {},
    commandContext: null,
    runCommand: async () => {},
    runCommandWithArgs: async () => {},
  }

  return (
    <SpotlightInternalContext.Provider value={context}>
      <SpotlightResults
        listboxId="spotlight-results"
        highlightedIndex={highlightedIndex}
        onHighlightChange={() => {}}
        onRun={() => {}}
        activeScopeId="root"
      />
    </SpotlightInternalContext.Provider>
  )
}

describe('SpotlightResults', () => {
  it('scrolls the highlighted row into view when keyboard navigation changes selection', async () => {
    const scrollIntoView = mock(() => {})
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoView

    try {
      const { rerender } = render(renderResults(0))

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
      scrollIntoView.mockClear()

      rerender(renderResults(8))

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
      })
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
  })
})
