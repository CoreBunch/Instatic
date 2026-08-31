/**
 * InsetBoxControl — the Position section's inset box with its pins.
 *
 * A pin that only lights up is decoration. These pin the actual contract:
 * pinning an edge stops that edge accepting edits, and unpinning gives it
 * back — while the other three edges are untouched either way. The lock set
 * lives in the editor store (`lockedInsetSides`) so the canvas free-move drag
 * shares it; the pinbox core is the free-move indicator that clears all pins.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { InsetBoxControl } from '@admin/pages/site/panels/PropertiesPanel/SpacingBoxControl/InsetBoxControl'

// The lock set is global editor-store state now — start each test unpinned.
beforeEach(() => {
  useEditorStore.setState({ lockedInsetSides: [] })
})

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

  it('pins write to the editor store, where the canvas drag reads them', () => {
    renderBox({ top: '10px' })

    fireEvent.click(screen.getByLabelText('Pin top edge'))
    expect(useEditorStore.getState().lockedInsetSides).toEqual(['top'])

    fireEvent.click(screen.getByLabelText('Pin left edge'))
    expect(useEditorStore.getState().lockedInsetSides).toEqual(['top', 'left'])
    cleanup()
  })

  it('the core reads free-move while nothing is pinned, and a click restores it', () => {
    renderBox({ top: '10px' })

    const core = screen.getByLabelText('Free move — drag the element on the canvas')
    expect(core.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByLabelText('Pin top edge'))
    fireEvent.click(screen.getByLabelText('Pin left edge'))
    expect(core.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(core)

    expect(useEditorStore.getState().lockedInsetSides).toEqual([])
    expect(core.getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText('Inset top') as HTMLInputElement).readOnly).toBe(false)
    cleanup()
  })
})


describe('InsetBoxControl — band scrub', () => {
  function edgeLabel(ariaLabel: string): HTMLElement {
    const input = screen.getByLabelText(ariaLabel) as HTMLInputElement
    const label = document.querySelector(`label[for="${input.id}"]`)
    if (!(label instanceof HTMLElement)) throw new Error(`no label for ${ariaLabel}`)
    return label
  }

  function moveTo(x: number, y: number) {
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: x, clientY: y, cancelable: true }),
      )
    })
  }

  it('dragging an edge previews live and commits once on release', () => {
    const onChange = renderBox({ right: '10px' })
    const label = edgeLabel('Inset right')

    fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    moveTo(130, 100)

    // Mid-drag: field mirrors the draft, nothing committed yet.
    expect(onChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Inset right') as HTMLInputElement).value).toBe('40')

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(onChange.mock.calls).toEqual([['right', '40px']])
  })

  it('offsets scrub into the negative', () => {
    const onChange = renderBox({ left: '5px' })
    fireEvent.pointerDown(edgeLabel('Inset left'), {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    })
    moveTo(140, 100) // left edge grows leftward; +40 right = -35
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(onChange.mock.calls).toEqual([['left', '-35px']])
  })

  it('a pinned edge does not scrub', () => {
    useEditorStore.setState({ lockedInsetSides: ['top'] })
    const onChange = renderBox({ top: '10px' })
    fireEvent.pointerDown(edgeLabel('Inset top'), {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    })
    moveTo(100, 60)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})
