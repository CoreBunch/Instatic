import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tooltip } from '@ui/components/Tooltip'

afterEach(cleanup)

describe('Tooltip', () => {
  it('renders the trigger as-is without a tooltip when not hovered', () => {
    render(
      <Tooltip content="Hello tooltip">
        <button>Trigger</button>
      </Tooltip>,
    )

    // Tooltip bubble must not be in the DOM before any interaction.
    expect(screen.queryByRole('tooltip')).toBeNull()
    // The trigger itself must still render.
    expect(screen.getByRole('button', { name: 'Trigger' })).toBeDefined()
  })

  it('shows the tooltip on mouseenter and hides on mouseleave', () => {
    render(
      <Tooltip content="Tooltip content">
        <button>Trigger</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Trigger' })

    fireEvent.mouseEnter(trigger)

    const bubble = screen.getByRole('tooltip')
    expect(bubble).toBeDefined()
    expect(bubble.textContent).toContain('Tooltip content')

    fireEvent.mouseLeave(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows on keyboard focus and hides on blur', () => {
    render(
      <Tooltip content="Keyboard detail" openOnFocus>
        <button>Trigger</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Trigger' })
    fireEvent.focus(trigger)

    const bubble = screen.getByRole('tooltip')
    expect(bubble.textContent).toContain('Keyboard detail')
    expect(trigger.getAttribute('aria-describedby')).toBe(bubble.id)

    fireEvent.blur(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('stays open until both hover and focus leave', () => {
    render(
      <Tooltip content="Persistent detail" openOnFocus>
        <button>Trigger</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Trigger' })
    fireEvent.mouseEnter(trigger)
    fireEvent.focus(trigger)
    fireEvent.mouseLeave(trigger)
    expect(screen.getByRole('tooltip')).toBeDefined()

    fireEvent.blur(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('disabled prop skips wrapping — no portal, no role=tooltip ever appears', () => {
    render(
      <Tooltip content="Never shown" disabled>
        <button>Trigger</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Trigger' })

    // No tooltip before or after hover because the Tooltip is disabled.
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseLeave(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('applies aria-describedby to the trigger when shown and removes it on hide', () => {
    render(
      <Tooltip content="Describe me">
        <button>Trigger</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Trigger' })
    expect(trigger.getAttribute('aria-describedby')).toBeNull()

    fireEvent.mouseEnter(trigger)

    const tooltipId = screen.getByRole('tooltip').id
    expect(tooltipId).toBeTruthy()
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltipId)

    fireEvent.mouseLeave(trigger)
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
  })

  it('preserves an existing aria-describedby value', () => {
    render(
      <>
        <p id="existing-description">Existing description</p>
        <Tooltip content="Extra detail" openOnFocus>
          <button aria-describedby="existing-description">Trigger</button>
        </Tooltip>
      </>,
    )

    const trigger = screen.getByRole('button', { name: 'Trigger' })
    fireEvent.focus(trigger)
    const tooltipId = screen.getByRole('tooltip').id
    expect(trigger.getAttribute('aria-describedby')).toBe(`existing-description ${tooltipId}`)

    fireEvent.blur(trigger)
    expect(trigger.getAttribute('aria-describedby')).toBe('existing-description')
  })

  it('hides on Escape keydown', () => {
    render(
      <Tooltip content="Press Escape to close">
        <button>Trigger</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Trigger' })

    fireEvent.mouseEnter(trigger)
    expect(screen.getByRole('tooltip')).toBeDefined()

    // Global keydown on document.body bubbles to window where our listener lives.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('consumes Escape before a parent panel handler can close', () => {
    let parentEscapeCount = 0
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') parentEscapeCount += 1
    }
    document.addEventListener('keydown', onKeyDown)

    try {
      render(
        <Tooltip content="Press Escape to close" openOnFocus>
          <button>Trigger</button>
        </Tooltip>,
      )
      const trigger = screen.getByRole('button', { name: 'Trigger' })
      act(() => trigger.focus())

      fireEvent.keyDown(trigger, { key: 'Escape' })

      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(parentEscapeCount).toBe(0)
      expect(document.activeElement).toBe(trigger)
    } finally {
      document.removeEventListener('keydown', onKeyDown)
    }
  })
})
