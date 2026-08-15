/**
 * TourOverlay — coverage for the idle/active render split, step
 * progression, Escape dismiss, and the anchor-missing soft-skip. Colocated
 * with the component per `src/admin/` convention (see
 * OnboardingPanel.test.tsx).
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TourOverlay } from './TourOverlay'
import { useTourStore } from './tourStore'
import type { TourStepDef } from './types'

const anchors: HTMLElement[] = []

function createAnchor(testId: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-testid', testId)
  document.body.appendChild(el)
  anchors.push(el)
  return el
}

afterEach(() => {
  cleanup()
  useTourStore.setState({ steps: null, stepIndex: 0, onEnd: null })
  anchors.splice(0).forEach((el) => el.remove())
})

describe('TourOverlay', () => {
  it('renders nothing when idle', () => {
    render(<TourOverlay />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows an anchored bubble, then advances to a centered step whose button reads "Finish"', async () => {
    createAnchor('target-a')
    const steps: TourStepDef[] = [
      { id: 'a', anchor: 'target-a', title: 'First step', body: 'Body A' },
      { id: 'b', anchor: null, title: 'Last step', body: 'Body B' },
    ]
    const onEnd = mock()

    render(<TourOverlay />)
    act(() => {
      useTourStore.getState().start(steps, onEnd)
    })

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Step 1 of 2')).toBeTruthy()
    expect(within(dialog).getByText('First step')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => {
      expect(within(screen.getByRole('dialog')).getByText('Step 2 of 2')).toBeTruthy()
    })
    expect(within(screen.getByRole('dialog')).getByText('Last step')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish' })).toBeTruthy()
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('Escape dismisses the tour and onEnd receives "dismissed"', async () => {
    createAnchor('target-esc')
    const steps: TourStepDef[] = [{ id: 'a', anchor: 'target-esc', title: 'Step', body: 'Body' }]
    const onEnd = mock()

    render(<TourOverlay />)
    act(() => {
      useTourStore.getState().start(steps, onEnd)
    })

    await screen.findByRole('dialog')

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(onEnd).toHaveBeenCalledWith('dismissed'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('soft-skips a step whose anchor never appears, warns, and lands on the following step', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const steps: TourStepDef[] = [
      { id: 'missing', anchor: 'does-not-exist', title: 'Missing', body: 'Body' },
      { id: 'centered', anchor: null, title: 'Centered', body: 'Body' },
    ]
    const onEnd = mock()

    render(<TourOverlay />)
    act(() => {
      useTourStore.getState().start(steps, onEnd)
    })

    await waitFor(
      () => {
        expect(within(screen.getByRole('dialog')).getByText('Centered')).toBeTruthy()
      },
      { timeout: 4000 },
    )
    expect(warnSpy).toHaveBeenCalledWith('[tour] anchor missing, skipping step:', 'missing')
    expect(onEnd).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
