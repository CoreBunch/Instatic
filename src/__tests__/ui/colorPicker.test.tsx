import { afterEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { ColorPicker } from '@ui/components/ColorPicker'

afterEach(cleanup)

function ControlledPicker({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue)
  const [previous, setPrevious] = useState(initialValue)

  return <>
    <ColorPicker value={value} gradients onChange={(next) => {
      setPrevious(value)
      setValue(next)
    }} />
    <output aria-label="Stored fill">{value}</output>
    <button onClick={() => setValue(previous)}>Undo</button>
  </>
}

it('shows the restored color after undoing an edit with the picker open', async () => {
  render(<ControlledPicker initialValue="#000000" />)
  const field = screen.getByRole('textbox', { name: 'Colour value (HEX)' }) as HTMLInputElement
  const stored = screen.getByLabelText('Stored fill')

  for (const value of ['#ff0000', '#00ff00']) {
    fireEvent.change(field, { target: { value } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(stored.textContent?.toLowerCase()).toBe(value))
  }

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(stored.textContent?.toLowerCase()).toBe('#ff0000')
  expect(field.value.toLowerCase()).toBe('#ff0000')
})

it('positions, inserts and deletes radial gradient stops with the keyboard', async () => {
  render(<ControlledPicker initialValue="radial-gradient(circle, #000000 0%, #ffffff 100%)" />)
  const first = screen.getByRole('slider', { name: 'Fill stop 1 position' })
  const stored = screen.getByLabelText('Stored fill')

  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowRight', shiftKey: true })
  expect(first.getAttribute('aria-valuenow')).toBe('10')
  await waitFor(() => expect(stored.textContent).toMatch(/#000000 10%/i))

  fireEvent.keyDown(first, { key: 'Insert' })
  const inserted = screen.getByRole('slider', { name: 'Fill stop 3 position' })
  expect(inserted.getAttribute('aria-valuenow')).toBe('55')
  await waitFor(() => expect(document.activeElement).toBe(inserted))
  await waitFor(() => expect(stored.textContent).toMatch(/55%/))

  fireEvent.keyDown(inserted, { key: 'Delete' })
  expect(screen.queryByRole('slider', { name: 'Fill stop 3 position' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('slider', { name: 'Fill stop 2 position' }))
  await waitFor(() => expect(stored.textContent?.toLowerCase()).toBe('radial-gradient(circle, #000000 10%, #ffffff 100%)'))
})
