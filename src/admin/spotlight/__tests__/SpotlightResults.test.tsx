import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SpotlightInternalContext, type SpotlightInternalContextValue } from '../spotlightContext'
import { SpotlightResults } from '../SpotlightResults'
import type { Command } from '../types'
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

  it('selects a select-type arg value when its option row is clicked', () => {
    const onSelectArg = mock(() => {})
    const command: Command = {
      id: 'test.cmd',
      title: 'Test command',
      group: 'plugins',
      args: [
        {
          id: 'tone',
          label: 'Tone',
          type: 'select',
          options: [
            { value: 'formal', label: 'Formal' },
            { value: 'casual', label: 'Casual' },
          ],
        },
      ],
    }

    const context: SpotlightInternalContextValue = {
      state: {
        ...makeOpenState(0),
        argMode: { command, argIndex: 0, values: {} },
      },
      dispatch: () => {},
      commandContext: null,
      runCommand: async () => {},
      runCommandWithArgs: async () => {},
    }

    render(
      <SpotlightInternalContext.Provider value={context}>
        <SpotlightResults
          listboxId="spotlight-results"
          highlightedIndex={0}
          onHighlightChange={() => {}}
          onSelectArg={onSelectArg}
          onRun={() => {}}
          activeScopeId="root"
        />
      </SpotlightInternalContext.Provider>,
    )

    fireEvent.click(screen.getByText('Casual'))

    expect(onSelectArg).toHaveBeenCalledTimes(1)
    expect(onSelectArg).toHaveBeenCalledWith('casual')
  })
})
