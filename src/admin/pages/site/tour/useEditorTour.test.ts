/**
 * useEditorTour — coverage for the auto-start guard, the auto-start-vs-
 * already-running race guard, and outcome persistence. Colocated with the
 * hook per `src/admin/` convention (see OnboardingPanel.test.tsx).
 *
 * `getUserPreference` / `setUserPreference` are mocked via `mock.module`
 * (see McpTab.test.tsx / pluginScheduler.test.ts) — the plain named
 * function exports of `@core/persistence/userPreferences` aren't spy-able
 * as object methods the way `cmsAdapter`'s class-instance methods are.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { TourStepDef } from '@admin/shared/tour'
import { useTourStore } from '@admin/shared/tour'
import type { EditorTourPreference } from '@core/persistence/userPreferences'

const getUserPreferenceMock = mock(async (): Promise<EditorTourPreference | null> => null)
const setUserPreferenceMock = mock(async (_key: string, value: unknown) => value)

mock.module('@core/persistence/userPreferences', () => ({
  getUserPreference: getUserPreferenceMock,
  setUserPreference: setUserPreferenceMock,
}))

const { startEditorTour, useEditorTour } = await import('./useEditorTour')
const { editorTourSteps } = await import('./editorTourSteps')

/** Flushes the microtask queue so the effect's promise chain settles. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  cleanup()
  useTourStore.setState({ steps: null, stepIndex: 0, onEnd: null })
  getUserPreferenceMock.mockReset()
  getUserPreferenceMock.mockImplementation(async () => null)
  setUserPreferenceMock.mockReset()
  setUserPreferenceMock.mockImplementation(async (_key: string, value: unknown) => value)
})

describe('useEditorTour', () => {
  it('starts the tour with the 7 editor steps when the preference resolves null and nothing is running', async () => {
    getUserPreferenceMock.mockImplementation(async () => null)

    renderHook(() => useEditorTour())

    await waitFor(() => expect(useTourStore.getState().steps).toBe(editorTourSteps))
    expect(useTourStore.getState().steps).toHaveLength(7)
    expect(useTourStore.getState().stepIndex).toBe(0)
  })

  it('does not restart a tour that is already running, even when the preference resolves null', async () => {
    getUserPreferenceMock.mockImplementation(async () => null)

    const runningSteps: TourStepDef[] = [{ id: 'other', anchor: null, title: 'T', body: 'B' }]
    const onEnd = mock()
    useTourStore.setState({ steps: runningSteps, stepIndex: 1, onEnd })

    renderHook(() => useEditorTour())

    await waitFor(() => expect(getUserPreferenceMock).toHaveBeenCalledTimes(1))
    await flush()

    expect(useTourStore.getState().steps).toBe(runningSteps)
    expect(useTourStore.getState().stepIndex).toBe(1)
    expect(useTourStore.getState().onEnd).toBe(onEnd)
  })

  it('does not auto-start when the preference resolves already-completed', async () => {
    getUserPreferenceMock.mockImplementation(async () => ({ status: 'completed' }))

    renderHook(() => useEditorTour())

    await waitFor(() => expect(getUserPreferenceMock).toHaveBeenCalledTimes(1))
    await flush()

    expect(useTourStore.getState().steps).toBeNull()
  })

  it('warns with the [editor-tour] prefix and skips auto-start when the preference read rejects', async () => {
    const warnSpy = mock(() => {})
    const originalWarn = console.warn
    console.warn = warnSpy as typeof console.warn

    const readError = new Error('network down')
    getUserPreferenceMock.mockImplementation(async () => {
      throw readError
    })

    try {
      renderHook(() => useEditorTour())

      await waitFor(() => expect(warnSpy).toHaveBeenCalled())
      expect(warnSpy.mock.calls[0]?.[0]).toBe(
        '[editor-tour] preference read failed, skipping auto-start:',
      )
      expect(warnSpy.mock.calls[0]?.[1]).toBe(readError)
      expect(useTourStore.getState().steps).toBeNull()
    } finally {
      console.warn = originalWarn
    }
  })

  it('persists {status: "completed"} via setUserPreference on tour completion', async () => {
    act(() => {
      startEditorTour()
    })
    expect(useTourStore.getState().steps).toBe(editorTourSteps)

    act(() => {
      useTourStore.getState().complete()
    })

    await waitFor(() => expect(setUserPreferenceMock).toHaveBeenCalledTimes(1))
    expect(setUserPreferenceMock).toHaveBeenCalledWith('editor-tour', { status: 'completed' })
  })

  it('logs console.error and does not throw when the completion PUT rejects', async () => {
    const errorSpy = mock(() => {})
    const originalError = console.error
    console.error = errorSpy as typeof console.error

    const putError = new Error('PUT failed')
    setUserPreferenceMock.mockImplementation(async () => {
      throw putError
    })

    try {
      act(() => {
        startEditorTour()
      })

      expect(() => {
        act(() => {
          useTourStore.getState().complete()
        })
      }).not.toThrow()

      await waitFor(() => expect(errorSpy).toHaveBeenCalled())
      expect(errorSpy.mock.calls[0]?.[0]).toBe('[editor-tour] failed to save tour state:')
      expect(errorSpy.mock.calls[0]?.[1]).toBe(putError)
    } finally {
      console.error = originalError
    }
  })
})
