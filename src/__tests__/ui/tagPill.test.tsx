import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TagPill } from '@ui/components/TagPill'
import { pillAccent } from '@ui/pillAccent'

afterEach(cleanup)

describe('TagPill', () => {
  it('colours a state tone from the semantic token instead of the label accent', () => {
    render(<TagPill label="Awaiting review" tone="warning" />)

    const pill = screen.getByText('Awaiting review').closest('[data-tone]') as HTMLElement

    expect(pill.getAttribute('data-tone')).toBe('warning')
    expect(pill.style.getPropertyValue('--pill-accent')).toBe('var(--warning)')
  })

  it('renders a read-only tinted label from the label text', () => {
    render(<TagPill label=".alpha" />)

    const label = screen.getByText('.alpha')
    const pill = label.closest('[data-accent]') as HTMLElement

    expect(pill).toBeTruthy()
    expect(pill.getAttribute('data-accent')).toBe(pillAccent('.alpha'))
    expect(pill.getAttribute('data-active')).toBeNull()
  })

  it('supports active selectable pills with a remove action', () => {
    let toggles = 0
    let removes = 0

    render(
      <TagPill
        label=".card"
        active
        onClick={() => { toggles += 1 }}
        onRemove={() => { removes += 1 }}
        mainAriaLabel="Edit class .card"
        removeAriaLabel="Remove class .card"
        removeTooltip="Remove from this element"
      />,
    )

    const pill = screen.getByText('.card').closest('[data-accent]') as HTMLElement
    expect(pill.getAttribute('data-active')).toBe('true')

    const mainButton = screen.getByRole('button', { name: 'Edit class .card' })
    expect(mainButton.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(mainButton)
    expect(toggles).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove class .card' }))
    expect(removes).toBe(1)
  })

  it('assigns the visible clickable pill area to buttons, not inert wrapper padding', () => {
    const css = readFileSync('src/ui/components/TagPill/TagPill.module.css', 'utf8')

    expect(css).toMatch(
      /\.pill\[data-clickable="true"\]\s*\{[^}]*padding:\s*0;[^}]*gap:\s*0;/s,
    )
    expect(css).toMatch(
      /\.pill\[data-size="sm"\]\[data-clickable="true"\]\s+\.mainButton\.mainButton\s*\{[^}]*min-height:\s*20px;[^}]*padding:\s*0 var\(--space-s\);/s,
    )
    expect(css).toMatch(
      /\.pill\[data-size="sm"\]\s+\.removeButton\.removeButton\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s,
    )
  })
})
