import { afterEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NumericStyleInput } from '@site/property-controls/NumericStyleInput'

afterEach(cleanup)

it('preserves fractional CSS units and supports coarse keyboard steps', () => {
  const adjust = mock()
  render(<NumericStyleInput aria-label="Offset" value="1.125rem" increment={0.1} onAdjust={adjust} readOnly={false} onChange={() => {}} />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown', shiftKey: true })
  expect(adjust).toHaveBeenCalledWith('0.125rem')
})

it('preserves a framework reference when arrow keys are used', () => {
  const adjust = mock()
  render(<NumericStyleInput aria-label="Gap" value="var(--space-m)" onAdjust={adjust} onChange={() => {}} />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' })
  expect(adjust).not.toHaveBeenCalled()
})

it('steps a unitless zero into a valid CSS length and respects the lower bound', () => {
  const adjust = mock()
  render(<NumericStyleInput aria-label="Radius" value="0" min={0} defaultUnit="px" onAdjust={adjust} onChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Increase Radius' }))
  fireEvent.click(screen.getByRole('button', { name: 'Decrease Radius' }))
  expect(adjust.mock.calls).toEqual([['1px'], ['0px']])
})

it('previews each scrubbed value and commits only when released', () => {
  const preview = mock()
  const commit = mock()
  const clear = mock()
  render(<NumericStyleInput aria-label="Width" value="20px" onAdjust={commit}
    onScrubPreview={preview} onClearPreview={clear} onChange={() => {}} />)
  const field = screen.getByRole('textbox')
  field.setPointerCapture = () => {}
  const pointer = { pointerId: 1, isPrimary: true, button: 0 }
  fireEvent.pointerDown(field, { ...pointer, clientX: 0 })
  fireEvent.pointerMove(field, { ...pointer, clientX: 12 })
  expect(preview.mock.calls).toEqual([['23px']])
  expect(commit).not.toHaveBeenCalled()
  fireEvent.keyDown(field, { key: 'Escape' })
  fireEvent.pointerUp(field, pointer)
  expect(clear).toHaveBeenCalledTimes(1)
  expect(commit).not.toHaveBeenCalled()
  fireEvent.pointerDown(field, { ...pointer, clientX: 0 })
  fireEvent.pointerMove(field, { ...pointer, clientX: 16 })
  fireEvent.pointerMove(field, { ...pointer, clientX: 20 })
  fireEvent.pointerUp(field, pointer)
  expect(commit.mock.calls).toEqual([['25px']])
  expect(clear).toHaveBeenCalledTimes(2)
})
