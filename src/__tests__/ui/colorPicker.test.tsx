import { afterEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { ColorPicker, formatColor, parseColor, parseGradient, formatGradient } from '@ui/components/ColorPicker'

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


it('rejects malformed channels and preserves authored hue units and hex alpha', () => {
  expect(parseColor('rgb(bad 10 20)')).toBeNull()
  expect(parseColor('hsl(0 80% 50% / nope)')).toBeNull()
  expect(parseColor('rgb(1, 2 / 3)')).toBeNull()
  expect(formatColor(parseColor('hsl(.5turn 100% 50%)')!, 'hex')).toBe('#00ffff')
  expect(formatColor(parseColor('#abcdef01')!, 'hex')).toBe('#abcdef01')
})

it('opens authored gradients outside the visual model as editable CSS', () => {
  const value = 'conic-gradient(at 25% 75%, var(--brand), #123, #abc)'
  render(<ControlledPicker initialValue={value} />)
  const field = screen.getByRole('textbox', { name: 'CSS color or gradient' }) as HTMLInputElement
  expect(field.value).toBe(value)
  expect(screen.queryByRole('slider')).toBeNull()
  expect(screen.getByLabelText('Stored fill').textContent).toBe(value)
})

it('keeps implicit radial geometry and refuses unrepresentable stop values', () => {
  const radial = parseGradient('radial-gradient(#123, #abc)')!
  expect(formatGradient(radial, 'hex')).toContain('radial-gradient(ellipse,')
  expect(parseGradient('radial-gradient(var(--first-stop), #123, #abc)')).toBeNull()
  expect(parseGradient('linear-gradient(#123 -5%, #abc 35%)')).toBeNull()
})
