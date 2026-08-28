/**
 * SizeSection — the Figma-style Width/Height editor.
 *
 * Pins the value-rewriting rules, because they're silent when wrong: a bare
 * number committed without its mode's unit is invalid CSS the browser drops,
 * and a broken ratio link would overwrite the other dimension with garbage.
 */
import { describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { SizeSection } from '@admin/pages/site/panels/PropertiesPanel/SizeSection'

function renderSection(
  styles: Record<string, unknown>,
  handlers: {
    onChange?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
    onChangeMany?: (patch: Partial<CSSPropertyBag>) => void
    onRemove?: (property: keyof CSSPropertyBag) => void
  } = {},
) {
  render(
    <SizeSection
      storedStyles={styles}
      currentStyles={styles}
      activeTab="base"
      onChange={handlers.onChange ?? (() => {})}
      onChangeMany={handlers.onChangeMany ?? (() => {})}
      onRemove={handlers.onRemove ?? (() => {})}
    />,
  )
}

describe('SizeSection', () => {
  it('appends the unit the active mode implies to bare numbers', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    renderSection({ width: '801px' }, { onChange })

    const input = screen.getByLabelText('Width') as HTMLInputElement
    fireEvent.change(input, { target: { value: '900' } })
    fireEvent.blur(input)

    expect(onChange).toHaveBeenCalledWith('width', '900px')
    cleanup()
  })

  it('rewrites the value when the sizing mode changes', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    renderSection({ width: '801px' }, { onChange })

    const select = screen.getByLabelText('Width sizing mode') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'fill' } })
    expect(onChange).toHaveBeenCalledWith('width', '100%')

    fireEvent.change(select, { target: { value: 'fit' } })
    expect(onChange).toHaveBeenCalledWith('width', 'fit-content')

    fireEvent.change(select, { target: { value: 'relative' } })
    expect(onChange).toHaveBeenCalledWith('width', '801%')
    cleanup()
  })

  it('scales the other dimension in one patch while the ratio is linked', () => {
    const onChangeMany = mock((_p: Partial<CSSPropertyBag>) => {})
    renderSection({ width: '800px', height: '400px' }, { onChangeMany })

    fireEvent.click(screen.getByRole('button', { name: 'Link width and height' }))
    const input = screen.getByLabelText('Width') as HTMLInputElement
    fireEvent.change(input, { target: { value: '900' } })
    fireEvent.blur(input)

    expect(onChangeMany).toHaveBeenCalledWith({ width: '900px', height: '450px' })
    cleanup()
  })

  it('disables the ratio link when a dimension has no numeric value', () => {
    renderSection({ width: '800px', height: 'fit-content' })
    // Button converts disabled+tooltip to aria-disabled so the tooltip
    // explaining WHY it's disabled still shows on hover.
    const link = screen.getByRole('button', { name: 'Link width and height' })
    expect(link.getAttribute('aria-disabled')).toBe('true')
    cleanup()
  })

  it('renders a constraint row only once the property is set', () => {
    // Constraints have no standing row — they are added from the section
    // header's "+" (SectionAddMenu) and then render as ordinary rows.
    renderSection({})
    expect(screen.queryByText('Max width')).toBeNull()
    cleanup()

    renderSection({ maxWidth: '100px' })
    expect(screen.getByText('Max width')).toBeTruthy()
    cleanup()
  })

  it('steps the numeric part of a dimension, keeping its unit', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    renderSection({ width: '80%' }, { onChange })

    // The stepper column is shared with the Input primitive (hover-revealed).
    fireEvent.click(screen.getAllByLabelText('Increase')[0])
    expect(onChange).toHaveBeenCalledWith('width', '81%')
    cleanup()
  })
})
