import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TextareaControl } from '@site/property-controls/TextareaControl'

afterEach(cleanup)

describe('properties-panel textarea under co-editing', () => {
  it('adopts a remote controlled value before the next local input event', () => {
    const commits: string[] = []
    const onChange = (_key: string, value: string) => {
      commits.push(value)
    }
    const view = render(
      <TextareaControl
        propKey="text"
        value="hello"
        onChange={onChange}
        label="Text"
        layout="stacked"
      />,
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    // A native edit has changed the DOM but its input event has not run yet.
    // Remote projection then re-renders the controlled property value.
    textarea.value = 'hello stale local'
    view.rerender(
      <TextareaControl
        propKey="text"
        value="hello remote"
        onChange={onChange}
        label="Text"
        layout="stacked"
      />,
    )
    expect(textarea.value).toBe('hello remote')

    // The next local event starts from the projected remote value rather than
    // committing the stale DOM snapshot over it.
    fireEvent.change(textarea, { target: { value: 'hello remote!' } })
    expect(commits).toEqual(['hello remote!'])
  })
})
