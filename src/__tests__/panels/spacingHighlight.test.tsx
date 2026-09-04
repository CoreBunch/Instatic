/**
 * Live spacing highlight — store wiring.
 *
 * Interacting with a side of the inspector's Spacing box mirrors the
 * interaction into `spacingHighlight` (selectionSlice), which drives the
 * translucent band + value chip the canvas draws over the selected element
 * (`SpacingHighlightOverlay`). The highlight lists every side a write would
 * touch: one side in split mode, all four in linked mode. It clears when the
 * interaction ends (control unmount, selection cleared) so the canvas never
 * keeps a stale band.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SpacingBoxControl } from '@site/panels/PropertiesPanel/SpacingBoxControl/SpacingBoxControl'
import { SpacingOverlayToggle } from '@site/panels/PropertiesPanel/SpacingBoxControl/SpacingOverlayToggle'
import { useEditorStore } from '@site/store/store'

beforeEach(() => {
  localStorage.clear()
  useEditorStore.setState({ spacingHighlight: null, spacingOverlayPinned: false })
})
afterEach(cleanup)

function renderControl(storedStyles: Record<string, unknown> = {}) {
  return render(
    <SpacingBoxControl
      storedStyles={storedStyles}
      currentStyles={{}}
      onChange={() => {}}
      onRemove={() => {}}
    />,
  )
}

/** The band segment (label) tied to a side input, resolved via htmlFor. */
function segmentFor(ariaLabel: string): Element {
  const input = screen.getByLabelText(ariaLabel)
  const segment = document.querySelector(`label[for="${input.id}"]`)
  expect(segment).toBeTruthy()
  return segment as Element
}

describe('SpacingBoxControl → spacingHighlight', () => {
  it('focusing a side input highlights that side (split mode)', () => {
    renderControl()

    fireEvent.focus(screen.getByLabelText('margin top'))

    expect(useEditorStore.getState().spacingHighlight).toEqual({
      box: 'margin',
      sides: ['top'],
    })
  })

  it('highlights all four sides in linked mode — the sides a write fans out to', () => {
    renderControl({
      paddingTop: '8px',
      paddingRight: '8px',
      paddingBottom: '8px',
      paddingLeft: '8px',
    })

    fireEvent.focus(screen.getByLabelText('padding left'))

    expect(useEditorStore.getState().spacingHighlight).toEqual({
      box: 'padding',
      sides: ['top', 'right', 'bottom', 'left'],
    })
  })

  it('hovering a band segment highlights its side; leaving falls back to the open editor target', () => {
    renderControl()

    // Focus opens the value editor on margin top.
    fireEvent.focus(screen.getByLabelText('margin top'))

    // Hovering another side previews that side's band…
    fireEvent.pointerEnter(segmentFor('padding bottom'))
    expect(useEditorStore.getState().spacingHighlight).toEqual({
      box: 'padding',
      sides: ['bottom'],
    })

    // …and leaving restores the editor's target instead of clearing.
    fireEvent.pointerLeave(segmentFor('padding bottom'))
    expect(useEditorStore.getState().spacingHighlight).toEqual({
      box: 'margin',
      sides: ['top'],
    })
  })

  it('hover-leave with no editor open clears the highlight', () => {
    renderControl()

    fireEvent.pointerEnter(segmentFor('margin right'))
    expect(useEditorStore.getState().spacingHighlight).toEqual({
      box: 'margin',
      sides: ['right'],
    })

    fireEvent.pointerLeave(segmentFor('margin right'))
    expect(useEditorStore.getState().spacingHighlight).toBeNull()
  })

  it('unmounting the control mid-interaction clears the highlight', () => {
    const view = renderControl()
    fireEvent.focus(screen.getByLabelText('margin top'))
    expect(useEditorStore.getState().spacingHighlight).not.toBeNull()

    view.unmount()

    expect(useEditorStore.getState().spacingHighlight).toBeNull()
  })

  it('clearSelection drops the highlight with the rest of the selection state', () => {
    useEditorStore.getState().setSpacingHighlight({ box: 'margin', sides: ['top'] })

    useEditorStore.getState().clearSelection()

    expect(useEditorStore.getState().spacingHighlight).toBeNull()
  })

  it('the "show all spacing" pin toggles the session flag and survives clearSelection', () => {
    render(<SpacingOverlayToggle />)
    const pin = screen.getByRole('button', { name: 'Show all spacing on the canvas' })
    expect(pin.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(pin)
    expect(useEditorStore.getState().spacingOverlayPinned).toBe(true)
    expect(pin.getAttribute('aria-pressed')).toBe('true')

    // A way of LOOKING at elements, not a per-element edit: reselecting must
    // not switch it off.
    useEditorStore.getState().clearSelection()
    expect(useEditorStore.getState().spacingOverlayPinned).toBe(true)

    fireEvent.click(pin)
    expect(useEditorStore.getState().spacingOverlayPinned).toBe(false)
  })
})
