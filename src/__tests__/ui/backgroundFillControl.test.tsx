/**
 * BackgroundFillControl — the background swatch is a FILL, not just a colour.
 *
 * CSS splits a fill across two properties (`background-color` for solids,
 * `background-image` for gradients) and the control hides that split. These
 * tests pin the routing, because getting it wrong is silent: a gradient
 * written to `background-color` is dead CSS the browser simply drops.
 */
import { describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { BackgroundFillControl } from '@site/property-controls/BackgroundFillControl'

const GRADIENT = 'linear-gradient(180deg, #ff0000 0%, #0000ff 100%)'

function renderControl(
  colorValue: string,
  imageValue: string,
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void,
) {
  render(
    <BackgroundFillControl
      propKey="backgroundColor"
      label="Background color"
      colorValue={colorValue}
      imageValue={imageValue}
      onChangeMany={onChangeMany}
    />,
  )
}

/** Open the picker panel and press one of its fill-type tabs. */
function pickFillMode(mode: string) {
  fireEvent.click(screen.getByRole('button', { name: /fill$/i }))
  fireEvent.click(screen.getByRole('button', { name: mode }))
}

describe('BackgroundFillControl', () => {
  it('routes a gradient to background-image and clears the colour', () => {
    const onChangeMany = mock((_p: Partial<CSSPropertyBag>) => {})
    renderControl('#ff0000', '', onChangeMany)

    pickFillMode('Linear gradient')

    const patch = onChangeMany.mock.calls.at(-1)?.[0]
    expect(patch?.backgroundImage).toMatch(/^linear-gradient\(/)
    // A leftover colour would paint over the gradient it just replaced.
    expect(patch).toHaveProperty('backgroundColor', undefined)
    cleanup()
  })

  it('routes a solid back to background-color and retires the gradient', () => {
    const onChangeMany = mock((_p: Partial<CSSPropertyBag>) => {})
    renderControl('', GRADIENT, onChangeMany)

    pickFillMode('Solid')

    const patch = onChangeMany.mock.calls.at(-1)?.[0]
    expect(typeof patch?.backgroundColor).toBe('string')
    expect(patch?.backgroundColor).not.toMatch(/gradient/)
    expect(patch).toHaveProperty('backgroundImage', undefined)
    cleanup()
  })

  it('leaves a picked IMAGE alone when a solid colour is set', () => {
    const onChangeMany = mock((_p: Partial<CSSPropertyBag>) => {})
    renderControl('', "url('/uploads/hero.jpg')", onChangeMany)

    // The row is `chip · value name · ×` now — a colour is typed in the
    // picker the chip opens, not in the row itself.
    fireEvent.click(screen.getByRole('button', { name: /fill$/i }))
    const hex = screen.getByLabelText(/^Colour value/i) as HTMLInputElement
    fireEvent.change(hex, { target: { value: '#00ff00' } })
    fireEvent.blur(hex)

    const patch = onChangeMany.mock.calls.at(-1)?.[0]
    expect(patch?.backgroundColor).toBe('#00ff00')
    // A colour behind an image is a legitimate pairing — don't wipe the image.
    expect(patch).not.toHaveProperty('backgroundImage')
    cleanup()
  })

  it('shows the gradient, not the colour, when both are set', () => {
    renderControl('#ff0000', GRADIENT, () => {})
    // background-image paints over background-color, so it is the real fill —
    // and the row names the value rather than printing its CSS.
    expect(screen.getByText('Linear')).toBeDefined()
    expect(screen.queryByText(/ff0000/i)).toBeNull()
    cleanup()
  })
})
