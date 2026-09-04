/**
 * ColorInput coalesces picker-drag change bursts at the primitive: the first
 * event fires onChange immediately (single clicks stay instant), the rest of
 * a drag collapses to one trailing fire with the latest value. Every consumer
 * commits onChange to the store (one collab frame per event in the editor),
 * so an unthrottled drag would overflow the socket backlog until the write
 * gate refuses edits.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ColorInput } from '@ui/components/ColorInput'

afterEach(cleanup)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('ColorInput drag coalescing', () => {
  it('fires a single change immediately', () => {
    const values: string[] = []
    render(
      <ColorInput
        defaultValue="#000000"
        aria-label="Swatch"
        onChange={(event) => values.push(event.target.value)}
      />,
    )
    fireEvent.change(screen.getByLabelText('Swatch'), { target: { value: '#ff0000' } })
    expect(values).toEqual(['#ff0000'])
  })

  it('collapses a drag burst to leading + trailing fires with the final value', async () => {
    const values: string[] = []
    render(
      <ColorInput
        defaultValue="#000000"
        aria-label="Swatch"
        onChange={(event) => values.push(event.target.value)}
      />,
    )
    const input = screen.getByLabelText('Swatch')
    fireEvent.change(input, { target: { value: '#110000' } })
    fireEvent.change(input, { target: { value: '#220000' } })
    fireEvent.change(input, { target: { value: '#330000' } })
    fireEvent.change(input, { target: { value: '#440000' } })
    expect(values).toEqual(['#110000'])

    await sleep(220)
    // The retained change event's target is the live input, so the trailing
    // fire reads the input's final value.
    expect(values).toEqual(['#110000', '#440000'])
  })

  it('flushes the pending trailing value on unmount instead of dropping it', () => {
    const values: string[] = []
    const view = render(
      <ColorInput
        defaultValue="#000000"
        aria-label="Swatch"
        onChange={(event) => values.push(event.target.value)}
      />,
    )
    const input = screen.getByLabelText('Swatch')
    fireEvent.change(input, { target: { value: '#110000' } })
    fireEvent.change(input, { target: { value: '#220000' } })
    expect(values).toEqual(['#110000'])
    view.unmount()
    expect(values).toEqual(['#110000', '#220000'])
  })
})
