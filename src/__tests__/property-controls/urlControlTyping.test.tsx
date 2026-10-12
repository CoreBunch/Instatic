/**
 * UrlControl — typing a URL.
 *
 * Only valid URLs are stored, and a URL is invalid at almost every keystroke
 * on the way to being complete. The field must therefore keep showing what is
 * being typed instead of snapping back to the stored value.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UrlControl } from '@site/property-controls/UrlControl'

afterEach(cleanup)

/** Holds the prop the way the editor store does: the control only sees stored values. */
function Harness({ initial, stored }: { initial: string; stored: string[] }) {
  const [value, setValue] = useState(initial)
  return (
    <UrlControl
      propKey="href"
      label="Link"
      value={value}
      onChange={(_key, next) => {
        stored.push(next)
        setValue(next)
      }}
    />
  )
}

function setup(initial = '') {
  const stored: string[] = []
  render(<Harness initial={initial} stored={stored} />)
  const field = () => screen.getByRole<HTMLInputElement>('textbox')
  const type = (text: string) => fireEvent.change(field(), { target: { value: text } })
  return { stored, field, type }
}

describe('UrlControl typing', () => {
  it('keeps each keystroke in the field while the URL is still incomplete', () => {
    const { stored, field, type } = setup()
    for (const partial of ['h', 'ht', 'http', 'https:', 'https://']) {
      type(partial)
      expect(field().value).toBe(partial)
    }
    expect(stored).toEqual([])
    expect(screen.getByRole('alert').textContent).toBe('Invalid URL')
  })

  it('stores the URL and clears the error once it becomes valid', () => {
    const { stored, field, type } = setup()
    type('https://')
    type('https://e')
    expect(stored).toEqual(['https://e'])
    expect(field().value).toBe('https://e')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('accepts a typed site-relative link', () => {
    const { stored, field, type } = setup()
    type('/')
    type('/about')
    type('#pricing')
    expect(stored).toEqual(['/', '/about', '#pricing'])
    expect(field().value).toBe('#pricing')
  })

  it('leaves the stored URL untouched while a replacement is being typed', () => {
    const { stored, field, type } = setup('https://example.com')
    type('exam')
    expect(field().value).toBe('exam')
    expect(stored).toEqual([])
  })

  it('drops an unfinished draft on blur and shows the stored URL again', () => {
    const { stored, field, type } = setup('https://example.com')
    type('exam')
    fireEvent.blur(field())
    expect(field().value).toBe('https://example.com')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(stored).toEqual([])
  })

  it('stores an emptied field, so a link can be removed', () => {
    const { stored, field, type } = setup('https://example.com')
    type('')
    expect(stored).toEqual([''])
    expect(field().value).toBe('')
  })
})
