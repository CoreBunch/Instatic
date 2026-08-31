/**
 * EffectsSection — effects as named rows over box-shadow / filter.
 *
 * The failures worth a gate are the destructive ones: adding one effect must
 * not eat another, and removing one must leave the rest of the declaration
 * standing.
 */
import { describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { EffectsSection } from '@admin/pages/site/panels/PropertiesPanel/EffectsSection'
import { EffectAddMenu } from '@admin/pages/site/panels/PropertiesPanel/EffectAddMenu'

type Change = (property: keyof CSSPropertyBag, value: string | number | undefined) => void

function renderSection(styles: Record<string, unknown>) {
  const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
  render(
    <EffectsSection
      storedStyles={styles}
      activeTab="base"
      visibleProperties={['transition', 'animation']}
      onChange={onChange as Change}
      onRemove={() => {}}
    />,
  )
  return onChange
}

describe('EffectsSection', () => {
  it('renders a row per effect, naming it instead of showing the declaration', () => {
    renderSection({
      boxShadow: '0 4px 4px rgba(0, 0, 0, 0.25), inset 0 2px 2px #000',
      backdropFilter: 'blur(4px)',
    })

    expect(screen.getByTestId('effect-row-dropShadow')).toBeTruthy()
    expect(screen.getByTestId('effect-row-innerShadow')).toBeTruthy()
    expect(screen.getByTestId('effect-row-backgroundBlur')).toBeTruthy()
    // The leading value is the summary, not the raw CSS.
    expect(screen.getByLabelText('Drop shadow — edit').textContent).toContain('0 4 · 4px')
    cleanup()
  })

  it('removing one shadow leaves the other entries of the list intact', () => {
    const onChange = renderSection({
      boxShadow: '0 4px 4px rgba(0, 0, 0, 0.25), inset 0 2px 2px #000000',
    })

    fireEvent.click(screen.getByLabelText('Remove Drop shadow'))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe('boxShadow')
    expect(String(onChange.mock.calls[0][1])).toBe('inset 0 2px 2px 0 #000000')
    cleanup()
  })

  it('removing a blur keeps the other filter functions', () => {
    const onChange = renderSection({ filter: 'blur(4px) grayscale(50%)' })

    fireEvent.click(screen.getByLabelText('Remove Layer blur'))

    expect(onChange.mock.calls[0]).toEqual(['filter', 'grayscale(50%)'])
    cleanup()
  })

  it('opens the parameters in a floating panel and edits through it', () => {
    const onChange = renderSection({ boxShadow: '0 4px 4px rgba(0, 0, 0, 0.25)' })

    fireEvent.click(screen.getByLabelText('Drop shadow — edit'))

    const blur = screen.getByLabelText('Blur') as HTMLInputElement
    expect(blur.value).toBe('4px')
    fireEvent.change(blur, { target: { value: '10px' } })

    expect(String(onChange.mock.calls[0][1])).toBe('0 4px 10px 0 rgba(0, 0, 0, 0.25)')
    cleanup()
  })

  it('drills the colour picker into the SAME panel, with a back arrow home', () => {
    renderSection({ boxShadow: '0 4px 4px rgba(0, 0, 0, 0.25)' })

    fireEvent.click(screen.getByLabelText('Drop shadow — edit'))
    fireEvent.click(screen.getByLabelText('Shadow colour'))

    // One panel, not a stacked second one; the header carries the
    // contextual title and the back arrow.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByText('Shadow color')).toBeTruthy()
    expect(screen.getByLabelText(/Colour value/)).toBeTruthy()

    // Back returns to the effect's parameters in the same panel.
    fireEvent.click(screen.getByLabelText('Back'))
    expect(screen.queryByLabelText(/Colour value/)).toBe(null)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByLabelText('Blur')).toBeTruthy()
    cleanup()
  })
})

describe('EffectAddMenu', () => {
  it('adds a shadow without dropping the one already there', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(
      <EffectAddMenu
        storedStyles={{ boxShadow: '0 1px 2px #000000' }}
        onChange={onChange as Change}
      />,
    )

    fireEvent.click(screen.getByLabelText('Add effect'))
    fireEvent.click(screen.getByRole('menuitem', { name: /inner shadow/i }))

    const written = String(onChange.mock.calls[0][1])
    expect(written.startsWith('0 1px 2px 0 #000000,')).toBe(true)
    expect(written).toContain('inset')
    cleanup()
  })

  it('lists an effect already on the element as dimmed and inert', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(<EffectAddMenu storedStyles={{ filter: 'blur(4px)' }} onChange={onChange as Change} />)

    fireEvent.click(screen.getByLabelText('Add effect'))
    const used = screen.getByRole('menuitem', { name: /layer blur/i })
    expect(
      used.getAttribute('disabled') !== null || used.getAttribute('aria-disabled') === 'true',
    ).toBe(true)

    fireEvent.click(used)
    expect(onChange).not.toHaveBeenCalled()
    cleanup()
  })
})
