/**
 * SectionAddMenu — the "+" menu in a style-section header.
 *
 * Pins the contract from docs/features/inspector-panel.md §7.1: a property
 * that already has a row stays LISTED but inert and ticked, an unset one adds
 * its default on click, and Enter takes the first item that is still addable
 * (never the dimmed one directly under the cursor of the search box).
 */
import { describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { SectionAddMenu } from '@admin/pages/site/panels/PropertiesPanel/SectionAddMenu'

const PROPERTIES: Array<keyof CSSPropertyBag> = ['float', 'clear', 'isolation']

function openMenu(storedStyles: Record<string, unknown>) {
  const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
  render(
    <SectionAddMenu
      sectionTitle="Position"
      properties={PROPERTIES}
      storedStyles={storedStyles}
      onChange={onChange}
    />,
  )
  fireEvent.click(screen.getByLabelText('Add Position property'))
  return onChange
}

describe('SectionAddMenu', () => {
  it('keeps an already-set property listed, dimmed and inert', () => {
    const onChange = openMenu({ float: 'left' })

    const used = screen.getByRole('menuitem', { name: /float/i })
    expect(used.getAttribute('disabled') !== null || used.getAttribute('aria-disabled') === 'true').toBe(true)

    fireEvent.click(used)
    expect(onChange).not.toHaveBeenCalled()
    cleanup()
  })

  it('adds an unset property with its default value', () => {
    const onChange = openMenu({})

    fireEvent.click(screen.getByRole('menuitem', { name: /clear/i }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe('clear')
    cleanup()
  })

  it('Enter adds the first property that is still addable', () => {
    // `float` is set, so it heads the list dimmed — Enter must skip past it.
    const onChange = openMenu({ float: 'left' })

    fireEvent.keyDown(screen.getByLabelText('Search Position properties'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe('clear')
    cleanup()
  })
})
