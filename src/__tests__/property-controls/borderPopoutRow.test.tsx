/**
 * BorderPopoutRow — the Border row's first click must put a visible border on
 * the element (1px solid white, every side, ONE commit), not open a popout of
 * empty fields. A row that already has a border just opens the editor.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { BorderPopoutRow } from '@admin/pages/site/panels/PropertiesPanel/BorderControl/BorderPopoutRow'

afterEach(cleanup)

function renderRow(stored: Record<string, unknown>, onChangeMany: (p: Partial<CSSPropertyBag>) => void) {
  render(
    <BorderPopoutRow
      storedStyles={stored}
      currentStyles={stored}
      activeTab="base"
      onChange={() => {}}
      onChangeMany={onChangeMany}
      onClearProperty={() => {}}
    />,
  )
}

describe('BorderPopoutRow', () => {
  it('seeds a 1px solid white border on every side when an empty row is clicked', () => {
    const onChangeMany = mock((_p: Partial<CSSPropertyBag>) => {})
    renderRow({}, onChangeMany)

    fireEvent.click(screen.getByRole('button', { name: 'Add a border' }))

    expect(onChangeMany).toHaveBeenCalledTimes(1)
    const patch = onChangeMany.mock.calls[0][0] as Record<string, string>
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      expect(patch[`border${side}Width`]).toBe('1px')
      expect(patch[`border${side}Style`]).toBe('solid')
      expect(patch[`border${side}Color`]).toBe('#ffffff')
    }
  })

  it('per-side mode stays per-side even though the seeded sides are identical', () => {
    const uniform: Record<string, unknown> = {}
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      uniform[`border${side}Width`] = '1px'
      uniform[`border${side}Style`] = 'solid'
      uniform[`border${side}Color`] = '#ffffff'
    }
    renderRow(uniform, () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Edit border — Solid' }))
    const dialog = screen.getByRole('dialog', { name: 'Border' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Edge separately' }))
    expect(within(dialog).getByRole('status').textContent).toBe('Editing top side')
    expect(within(dialog).getByLabelText('Border top width')).toBeTruthy()

    // Picking another edge keeps per-side mode and moves the target.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit left border' }))
    expect(within(dialog).getByRole('status').textContent).toBe('Editing left side')
  })

  it('a row with a border just opens the editor', () => {
    const onChangeMany = mock((_p: Partial<CSSPropertyBag>) => {})
    renderRow({ borderTopStyle: 'dashed', borderTopColor: '#ff0000' }, onChangeMany)

    fireEvent.click(screen.getByRole('button', { name: 'Edit border — Dashed' }))

    expect(onChangeMany).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Border' })).toBeTruthy()
  })
})
