/**
 * TokenAwareInput — drag-to-scrub as a preview/commit session.
 *
 * The field owns the gesture plumbing; the row supplies only the pure step
 * math (`stepValue`). While the pointer moves the field PREVIEWS
 * `stepValue(start, total)` every frame (canvas follows instantly, no store
 * writes), and release commits exactly once — one undo entry per drag.
 * Chevrons and arrow keys still commit each step.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { stepCssLength } from '@site/panels/PropertiesPanel/styleValueUtils'

afterEach(cleanup)

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function renderField(withPreview = true) {
  const onCommit = mock((_v: string | undefined) => {})
  const onPreview = mock((_v: string | undefined) => {})
  const onClearPreview = mock(() => {})
  render(
    <TokenAwareInput
      aria-label="Width"
      value="740px"
      tokens={[]}
      onCommit={onCommit}
      stepValue={(current, delta) => stepCssLength(current, delta)}
      onPreview={withPreview ? onPreview : undefined}
      onClearPreview={withPreview ? onClearPreview : undefined}
    />,
  )
  const input = screen.getByLabelText('Width') as HTMLInputElement
  const wrapper = input.parentElement as HTMLElement
  return { onCommit, onPreview, onClearPreview, input, wrapper }
}

describe('TokenAwareInput scrub', () => {
  it('previews every frame from the frozen start value and commits once on release', async () => {
    const { onCommit, onPreview, onClearPreview, input, wrapper } = renderField()

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 92 })
    await act(() => nextFrame())
    fireEvent.pointerMove(window, { clientX: 84 })
    await act(() => nextFrame())

    // Two frames, two previews, both relative to 740 — and no commit yet.
    expect(onPreview.mock.calls.map((c) => c[0])).toEqual(['738px', '736px'])
    expect(onCommit).not.toHaveBeenCalled()
    // The field shows the live number while the store still holds 740.
    expect(input.value).toBe('736')

    fireEvent.pointerUp(window, { clientX: 84 })
    expect(onClearPreview).toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0]).toBe('736px')
  })

  it('without a preview channel the frames commit, still from the frozen start', async () => {
    const { onCommit, wrapper } = renderField(false)

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 92 })
    await act(() => nextFrame())
    fireEvent.pointerMove(window, { clientX: 84 })
    await act(() => nextFrame())
    fireEvent.pointerUp(window, { clientX: 84 })

    expect(onCommit.mock.calls.map((c) => c[0])).toEqual(['738px', '736px', '736px'])
  })

  it('a chevron click commits one step through the same math', () => {
    const { onCommit } = renderField()
    fireEvent.click(screen.getByLabelText('Increase'))
    expect(onCommit).toHaveBeenCalledWith('741px')
  })

  it('a value with nothing to step (a token) stays put', () => {
    const onCommit = mock((_v: string | undefined) => {})
    render(
      <TokenAwareInput
        aria-label="Gap"
        value="var(--space-m)"
        tokens={[]}
        onCommit={onCommit}
        stepValue={(current, delta) => stepCssLength(current, delta)}
      />,
    )
    fireEvent.click(screen.getByLabelText('Increase'))
    expect(onCommit).not.toHaveBeenCalled()
  })
})
