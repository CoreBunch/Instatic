/**
 * InsetBoxControl — the Position section's inset box with its pins.
 *
 * A pin that only lights up is decoration. These pin the actual contract:
 * pinning an edge stops that edge accepting edits, and unpinning gives it
 * back — while the other three edges are untouched either way.
 */
import { describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { InsetBoxControl } from '@admin/pages/site/panels/PropertiesPanel/SpacingBoxControl/InsetBoxControl'

function renderBox(styles: Record<string, unknown> = {}) {
  const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
  render(
    <InsetBoxControl
      storedStyles={styles}
      currentStyles={styles}
      onChange={onChange}
    />,
  )
  return onChange
}

describe('InsetBoxControl', () => {
  it('shows one field per edge, defaulting to auto rather than 0', () => {
    renderBox()

    for (const side of ['top', 'right', 'bottom', 'left']) {
      const field = screen.getByLabelText(`Inset ${side}`) as HTMLInputElement
      expect(field.value).toBe('')
      // `auto` is what an unset offset resolves to; `0` would claim the
      // element is pinned to that edge.
      expect(field.placeholder).toBe('auto')
    }
    cleanup()
  })

  it('pinning an edge locks its field and leaves the others editable', () => {
    renderBox({ top: '10px', left: '4px' })

    const top = screen.getByLabelText('Inset top') as HTMLInputElement
    expect(top.readOnly).toBe(false)

    fireEvent.click(screen.getByLabelText('Pin top edge'))

    expect((screen.getByLabelText('Inset top') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Inset left') as HTMLInputElement).readOnly).toBe(false)
    cleanup()
  })

  it('unpinning gives the edge back', () => {
    renderBox({ top: '10px' })

    fireEvent.click(screen.getByLabelText('Pin top edge'))
    fireEvent.click(screen.getByLabelText('Unpin top edge'))

    expect((screen.getByLabelText('Inset top') as HTMLInputElement).readOnly).toBe(false)
    cleanup()
  })

  it('a pinned edge refuses a committed edit', () => {
    const onChange = renderBox({ top: '10px' })

    fireEvent.click(screen.getByLabelText('Pin top edge'))
    const top = screen.getByLabelText('Inset top')
    fireEvent.change(top, { target: { value: '99px' } })
    fireEvent.blur(top)

    expect(onChange).not.toHaveBeenCalled()
    cleanup()
  })

  it('an unpinned edge commits normally', () => {
    const onChange = renderBox({ top: '10px' })

    const top = screen.getByLabelText('Inset top')
    fireEvent.change(top, { target: { value: '24px' } })
    fireEvent.blur(top)

    expect(onChange).toHaveBeenCalledWith('top', '24px')
    cleanup()
  })
})
