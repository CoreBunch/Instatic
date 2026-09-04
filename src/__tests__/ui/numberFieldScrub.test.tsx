/**
 * Number field — drag left/right to scrub the value.
 *
 * The field with a stepper wears an `ew-resize` cursor; before this existed
 * that cursor promised a gesture nothing implemented. These pin the promise:
 * a press is not a drag until it travels, Shift makes each step ten, steps
 * are applied once per animation frame (a 1000 Hz mouse must not turn one
 * drag into hundreds of commits), and release flushes what is pending.
 */
import { describe, expect, it, mock } from 'bun:test'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Input } from '@ui/components/Input'

/** A real controlled number-ish field: each step lands in state, like a row. */
function SteppingField({ onApplied }: { onApplied: (value: number) => void }) {
  const [value, setValue] = useState(740)
  return (
    <Input
      aria-label="Width"
      value={String(value)}
      onChange={() => {}}
      onStep={(delta) => {
        const next = value + delta
        setValue(next)
        onApplied(next)
      }}
    />
  )
}

function renderField() {
  const onStep = mock((_delta: number) => {})
  render(<Input aria-label="Blur" value="4px" readOnly={false} onChange={() => {}} onStep={onStep} />)
  // The wrapper carries the gesture — the input itself keeps text editing.
  const wrapper = screen.getByLabelText('Blur').parentElement as HTMLElement
  return { onStep, wrapper }
}

/** Lets the scrub's per-frame flush run. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

describe('number field scrubbing', () => {
  it('does not step on a press that never moves', () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerUp(window, { clientX: 100 })

    expect(onStep).not.toHaveBeenCalled()
    cleanup()
  })

  it('ignores travel below the threshold, then steps once per 4px', async () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    // 2px — still a click in progress, not a drag.
    fireEvent.pointerMove(window, { clientX: 102 })
    await nextFrame()
    expect(onStep).not.toHaveBeenCalled()

    // 12px total: past the threshold and three steps' worth of travel.
    fireEvent.pointerMove(window, { clientX: 112 })
    await nextFrame()
    expect(onStep).toHaveBeenCalledTimes(1)
    expect(onStep.mock.calls[0][0]).toBe(3)

    fireEvent.pointerUp(window, { clientX: 112 })
    cleanup()
  })

  it('a burst of moves inside one frame becomes ONE step call', async () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    for (let x = 104; x <= 140; x += 4) fireEvent.pointerMove(window, { clientX: x })
    expect(onStep).not.toHaveBeenCalled()

    await nextFrame()
    expect(onStep).toHaveBeenCalledTimes(1)
    expect(onStep.mock.calls[0][0]).toBe(10)
    fireEvent.pointerUp(window, { clientX: 140 })
    cleanup()
  })

  it('every batch steps from the CURRENT value, not the one at pointerdown', async () => {
    const applied: number[] = []
    render(<SteppingField onApplied={(v) => applied.push(v)} />)
    const wrapper = screen.getByLabelText('Width').parentElement as HTMLElement

    // Drag left 8px per frame (two steps each): 740 → 738 → 736 → 734. The
    // old closure bug computed every batch from 740 (738, 738, 738 — or
    // 732, 737, 729 with a fast hand) and the value bounced.
    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 92 })
    await act(() => nextFrame())
    fireEvent.pointerMove(window, { clientX: 84 })
    await act(() => nextFrame())
    fireEvent.pointerMove(window, { clientX: 76 })
    await act(() => nextFrame())
    fireEvent.pointerUp(window, { clientX: 76 })

    expect(applied).toEqual([738, 736, 734])
    cleanup()
  })

  it('waits (a few frames) for the field to show the previous step before the next batch', async () => {
    // The static field never re-renders, so the second batch has no ack to
    // wait for — it must still land, after the wait cap, not never.
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 112 })
    await nextFrame()
    expect(onStep).toHaveBeenCalledTimes(1)

    fireEvent.pointerMove(window, { clientX: 124 })
    await nextFrame()
    expect(onStep).toHaveBeenCalledTimes(1)
    await nextFrame()
    await nextFrame()
    await nextFrame()
    expect(onStep).toHaveBeenCalledTimes(2)
    fireEvent.pointerUp(window, { clientX: 124 })
    cleanup()
  })

  it('onScrub gets the TOTAL since the grab each frame, then one end call', async () => {
    const onScrub = mock((_total: number, _phase: 'move' | 'end') => {})
    render(<Input aria-label="Blur" value="4px" onChange={() => {}} onStep={() => {}} onScrub={onScrub} />)
    const wrapper = screen.getByLabelText('Blur').parentElement as HTMLElement

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 112 })
    await nextFrame()
    fireEvent.pointerMove(window, { clientX: 104 })
    await nextFrame()
    fireEvent.pointerUp(window, { clientX: 104 })

    expect(onScrub.mock.calls).toEqual([
      [3, 'move'],
      [1, 'move'],
      [1, 'end'],
    ])
    cleanup()
  })

  it('release flushes the pending steps without waiting for a frame', () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 92 })
    fireEvent.pointerUp(window, { clientX: 92 })

    expect(onStep.mock.calls[0][0]).toBe(-2)
    cleanup()
  })

  it('Shift multiplies each step by ten', () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 108, shiftKey: true })
    fireEvent.pointerUp(window, { clientX: 108 })

    expect(onStep.mock.calls[0][0]).toBe(20)
    cleanup()
  })

  it('stops listening after the pointer is released', async () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 120 })
    fireEvent.pointerUp(window, { clientX: 120 })
    const callsAfterRelease = onStep.mock.calls.length

    fireEvent.pointerMove(window, { clientX: 200 })
    await nextFrame()
    expect(onStep.mock.calls.length).toBe(callsAfterRelease)
    cleanup()
  })
})
