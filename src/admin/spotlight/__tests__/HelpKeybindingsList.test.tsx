import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'
import { HelpKeybindingsList } from '../HelpKeybindingsList'

afterEach(() => {
  cleanup()
})

describe('HelpKeybindingsList', () => {
  it('lists the Hand tool shortcut under Canvas & Layers', () => {
    render(<HelpKeybindingsList />)

    const section = screen.getByRole('heading', { name: 'Canvas & Layers' }).closest('section')
    if (!section) throw new Error('Canvas & Layers section not rendered')
    const row = within(section).getByText('Toggle Hand tool').parentElement
    if (!row) throw new Error('Hand tool row not rendered')
    expect(within(row).getByText('H')).toBeTruthy()
  })

  it('lists the Select tool shortcut under Canvas & Layers', () => {
    render(<HelpKeybindingsList />)

    const section = screen.getByRole('heading', { name: 'Canvas & Layers' }).closest('section')
    if (!section) throw new Error('Canvas & Layers section not rendered')
    const row = within(section).getByText('Select tool').parentElement
    if (!row) throw new Error('Select tool row not rendered')
    expect(within(row).getByText('V')).toBeTruthy()
  })
})
