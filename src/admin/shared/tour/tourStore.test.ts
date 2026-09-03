/**
 * tourStore — coverage for start/next/back/dismiss/complete and the
 * outcome callback. Colocated with the store per `src/admin/` convention
 * (see OnboardingPanel.test.tsx).
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { useTourStore } from './tourStore'
import type { TourStepDef } from './types'

const steps: TourStepDef[] = [
  { id: 'a', anchor: null, title: 'A', body: 'a' },
  { id: 'b', anchor: 'x', title: 'B', body: 'b' },
]

beforeEach(() => useTourStore.setState({ steps: null, stepIndex: 0, onEnd: null }))

describe('tourStore', () => {
  it('start() sets steps at index 0 and throws on empty', () => {
    const onEnd = mock()
    useTourStore.getState().start(steps, onEnd)

    const state = useTourStore.getState()
    expect(state.steps).toBe(steps)
    expect(state.stepIndex).toBe(0)
    expect(onEnd).not.toHaveBeenCalled()

    expect(() => useTourStore.getState().start([], onEnd)).toThrow('Tour needs at least one step')
  })

  it('back() at 0 is a no-op; next() advances; next() at end completes with outcome', () => {
    const onEnd = mock()
    useTourStore.getState().start(steps, onEnd)

    useTourStore.getState().back()
    expect(useTourStore.getState().stepIndex).toBe(0)

    useTourStore.getState().next()
    expect(useTourStore.getState().stepIndex).toBe(1)
    expect(useTourStore.getState().steps).toBe(steps)

    useTourStore.getState().next()
    const state = useTourStore.getState()
    expect(state.steps).toBeNull()
    expect(state.stepIndex).toBe(0)
    expect(state.onEnd).toBeNull()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledWith('completed')
  })

  it('dismiss() ends with dismissed outcome', () => {
    const onEnd = mock()
    useTourStore.getState().start(steps, onEnd)

    useTourStore.getState().dismiss()

    const state = useTourStore.getState()
    expect(state.steps).toBeNull()
    expect(state.stepIndex).toBe(0)
    expect(state.onEnd).toBeNull()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledWith('dismissed')
  })

  it('complete() ends with completed outcome even before the last step', () => {
    const onEnd = mock()
    useTourStore.getState().start(steps, onEnd)

    useTourStore.getState().complete()

    const state = useTourStore.getState()
    expect(state.steps).toBeNull()
    expect(state.stepIndex).toBe(0)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledWith('completed')
  })

  it('next() and back() are no-ops when no tour is running', () => {
    useTourStore.getState().next()
    useTourStore.getState().back()

    const state = useTourStore.getState()
    expect(state.steps).toBeNull()
    expect(state.stepIndex).toBe(0)
  })
})
