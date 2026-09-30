import { afterEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AnimationControl } from '@site/property-controls/AnimationControl'

afterEach(cleanup)

it('edits duration while preserving delay, direction and easing', () => {
  const changes: string[] = []
  render(<AnimationControl propKey="animation" label="Animation"
    value="instatic-slide-up 600ms ease-out 200ms 1 both" onChange={(_, value) => changes.push(value)} />)
  fireEvent.change(screen.getByLabelText('Duration (ms)'), { target: { value: '900' } })
  expect(changes.at(-1)).toBe('instatic-slide-up 900ms ease-out 200ms 1 both')
  fireEvent.change(screen.getByLabelText('Delay (ms)'), { target: { value: '-5' } })
  expect(changes).toHaveLength(1)
})

it('shows custom CSS without rewriting imported animations', () => {
  const changes: string[] = []
  render(<AnimationControl propKey="animation" label="Animation"
    value="custom-spin 2s linear infinite" onChange={(_, value) => changes.push(value)} />)
  expect(screen.getByLabelText('Animation CSS').getAttribute('value')).toBe('custom-spin 2s linear infinite')
  expect(changes).toHaveLength(0)
})

it('preserves the scroll trigger when changing timing', () => {
  const changes: string[] = []
  render(<AnimationControl propKey="animation" label="Animation"
    value="instatic-slide-up-scroll 600ms ease-out 200ms 1 both" onChange={(_, value) => changes.push(value)} />)
  fireEvent.change(screen.getByLabelText('Duration (ms)'), { target: { value: '900' } })
  expect(changes.at(-1)).toBe('instatic-slide-up-scroll 900ms ease-out 200ms 1 both')
})
