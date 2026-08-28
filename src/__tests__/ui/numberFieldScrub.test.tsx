/**
 * Number field — drag left/right to scrub the value.
 *
 * The field with a stepper wears an `ew-resize` cursor; before this existed
 * that cursor promised a gesture nothing implemented. These pin the promise:
 * a press is not a drag until it travels, and Shift makes each step ten.
 */
import { describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Input } from '@ui/components/Input'

function renderField() {
  const onStep = mock((_delta: number) => {})
  render(<Input aria-label="Blur" value="4px" readOnly={false} onChange={() => {}} onStep={onStep} />)
  // The wrapper carries the gesture — the input itself keeps text editing.
  const wrapper = screen.getByLabelText('Blur').parentElement as HTMLElement
  return { onStep, wrapper }
}

describe('number field scrubbing', () => {
  it('does not step on a press that never moves', () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerUp(window, { clientX: 100 })

    expect(onStep).not.toHaveBeenCalled()
    cleanup()
  })

  it('ignores travel below the threshold, then steps once per 4px', () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    // 2px — still a click in progress, not a drag.
    fireEvent.pointerMove(window, { clientX: 102 })
    expect(onStep).not.toHaveBeenCalled()

    // 12px total: past the threshold and three steps' worth of travel.
    fireEvent.pointerMove(window, { clientX: 112 })
    expect(onStep).toHaveBeenCalledTimes(1)
    expect(onStep.mock.calls[0][0]).toBe(3)

    fireEvent.pointerUp(window, { clientX: 112 })
    cleanup()
  })

  it('steps backwards when dragged left', () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 92 })

    expect(onStep.mock.calls[0][0]).toBe(-2)
    fireEvent.pointerUp(window, { clientX: 92 })
    cleanup()
  })

  it('Shift multiplies each step by ten', () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 108, shiftKey: true })

    expect(onStep.mock.calls[0][0]).toBe(20)
    fireEvent.pointerUp(window, { clientX: 108 })
    cleanup()
  })

  it('stops listening after the pointer is released', () => {
    const { onStep, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 120 })
    const callsWhileDragging = onStep.mock.calls.length
    fireEvent.pointerUp(window, { clientX: 120 })

    fireEvent.pointerMove(window, { clientX: 200 })
    expect(onStep.mock.calls.length).toBe(callsWhileDragging)
    cleanup()
  })
})
