/**
 * PositionControl — `object-position` / `background-position` as a 3×3 anchor
 * grid popout with X / Y offset fields, instead of a free-text phrase.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { PositionControl } from '@site/property-controls/PositionControl'

afterEach(cleanup)

function renderControl(value: string, onChange = (_key: string, _value: string) => {}) {
  render(
    <PositionControl
      propKey="objectPosition"
      label="Object position"
      value={value}
      placeholder="center center"
      onChange={onChange}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Object position — edit' }))
  return screen.getByRole('dialog', { name: 'Object position' })
}

describe('PositionControl', () => {
  it('a percentage pair reads as its keyword anchor', () => {
    const dialog = renderControl('0% 0%')
    expect(within(dialog).getByRole('button', { name: 'left top' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(
      within(dialog).getByRole('button', { name: 'center center' }).getAttribute('aria-pressed'),
    ).toBe('false')
  })

  it('a single vertical keyword means center on the other axis', () => {
    const dialog = renderControl('bottom')
    expect(
      within(dialog).getByRole('button', { name: 'center bottom' }).getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('a tile commits both keywords; an offset field keeps the other axis', () => {
    const writes: string[] = []
    const dialog = renderControl('center center', (_key, next) => writes.push(next))

    fireEvent.click(within(dialog).getByRole('button', { name: 'right bottom' }))
    expect(writes.at(-1)).toBe('right bottom')

    const x = within(dialog).getByLabelText('Object position X')
    fireEvent.focus(x)
    fireEvent.change(x, { target: { value: '20' } })
    // `20` in the field's first unit (%) beside the untouched Y axis.
    expect(writes.at(-1)).toBe('20% center')
  })
})
