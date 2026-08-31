/**
 * ValueEditorPopout — the floating value editor a spacing / inset side opens
 * (docs/features/inspector-panel.md §6.6).
 *
 * The contract worth testing is the plumbing, not the pixels: the popout
 * opens on side focus and follows focus to another side, every write flows
 * through the SAME onChange path as inline typing (so preset clicks and
 * Reset land exactly like typed edits), a value the editor cannot parse
 * degrades to the disabled "complex" state, and a pinned inset edge never
 * opens the editor at all.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { SpacingBoxControl } from '@admin/pages/site/panels/PropertiesPanel/SpacingBoxControl/SpacingBoxControl'
import { InsetBoxControl } from '@admin/pages/site/panels/PropertiesPanel/SpacingBoxControl/InsetBoxControl'

beforeEach(() => {
  useEditorStore.setState({ lockedInsetSides: [] })
})

function renderSpacing(styles: Record<string, unknown> = {}) {
  const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
  const onRemove = mock((_p: keyof CSSPropertyBag) => {})
  render(
    <SpacingBoxControl
      storedStyles={styles}
      currentStyles={styles}
      onChange={onChange}
      onRemove={onRemove}
    />,
  )
  return onChange
}

function renderInset(styles: Record<string, unknown> = {}) {
  const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
  render(<InsetBoxControl storedStyles={styles} currentStyles={styles} onChange={onChange} />)
  return onChange
}

describe('ValueEditorPopout — spacing', () => {
  it('opens on side focus and follows focus to another side', () => {
    renderSpacing()

    fireEvent.focus(screen.getByLabelText('margin top'))
    expect(screen.getByRole('dialog', { name: 'Margin top' })).toBeTruthy()

    // One popout at a time: focusing another side moves it there.
    fireEvent.focus(screen.getByLabelText('padding left'))
    expect(screen.getByRole('dialog', { name: 'Padding left' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Margin top' })).toBeNull()
    cleanup()
  })

  it('a preset chip commits through the side input’s own change path', () => {
    const onChange = renderSpacing()

    fireEvent.focus(screen.getByLabelText('margin top'))
    const dialog = screen.getByRole('dialog', { name: 'Margin top' })
    fireEvent.click(within(dialog).getByRole('button', { name: '8' }))

    // The empty box starts split, so only the focused side is written —
    // exactly what a typed edit would have done.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('marginTop', '8px')
    cleanup()
  })

  it('offers Auto on margin but not on padding', () => {
    const onChange = renderSpacing()

    fireEvent.focus(screen.getByLabelText('margin top'))
    const marginDialog = screen.getByRole('dialog', { name: 'Margin top' })
    fireEvent.click(within(marginDialog).getByRole('button', { name: 'Auto' }))
    expect(onChange).toHaveBeenCalledWith('marginTop', 'auto')

    fireEvent.focus(screen.getByLabelText('padding top'))
    const paddingDialog = screen.getByRole('dialog', { name: 'Padding top' })
    expect(within(paddingDialog).queryByRole('button', { name: 'Auto' })).toBeNull()
    cleanup()
  })

  it('Reset clears the side back to unset via the same commit path', () => {
    const onChange = renderSpacing({ marginTop: '24px' })

    fireEvent.focus(screen.getByLabelText('margin top'))
    const dialog = screen.getByRole('dialog', { name: 'Margin top' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }))

    expect(onChange).toHaveBeenCalledWith('marginTop', undefined)
    cleanup()
  })

  it('a complex value disables slider and presets but keeps Reset', () => {
    renderSpacing({ marginTop: 'var(--space-m)' })

    fireEvent.focus(screen.getByLabelText('margin top'))
    const dialog = screen.getByRole('dialog', { name: 'Margin top' })

    expect(
      (within(dialog).getByLabelText('Margin top slider') as HTMLInputElement).disabled,
    ).toBe(true)
    expect(
      (within(dialog).getByRole('button', { name: '8' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (within(dialog).getByRole('button', { name: 'Reset' }) as HTMLButtonElement).disabled,
    ).toBe(false)
    cleanup()
  })
})

describe('ValueEditorPopout — inset', () => {
  it('a pinned edge does not open the editor; an unpinned one does', () => {
    renderInset({ top: '10px' })

    fireEvent.click(screen.getByLabelText('Pin top edge'))
    fireEvent.focus(screen.getByLabelText('Inset top'))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.focus(screen.getByLabelText('Inset left'))
    expect(screen.getByRole('dialog', { name: 'Inset left' })).toBeTruthy()
    cleanup()
  })

  it('preset and Reset write the edge through onChange', () => {
    const onChange = renderInset({ left: '10px' })

    fireEvent.focus(screen.getByLabelText('Inset left'))
    const dialog = screen.getByRole('dialog', { name: 'Inset left' })

    fireEvent.click(within(dialog).getByRole('button', { name: '8' }))
    expect(onChange).toHaveBeenCalledWith('left', '8px')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }))
    expect(onChange).toHaveBeenCalledWith('left', undefined)
    cleanup()
  })
})
