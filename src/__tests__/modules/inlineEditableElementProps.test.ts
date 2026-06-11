/**
 * inlineEditableElementProps — the prop bag a text module spreads onto its own
 * element so the element BECOMES the inline editor.
 *
 * The element is made `contentEditable=plaintext-only` (no rich formatting /
 * pasted markup) and the three live-edit handlers are wired through.
 *
 * It intentionally provides NO `dangerouslySetInnerHTML` and NO children:
 * React must not own the contentEditable element's content. React 19 re-applies
 * `dangerouslySetInnerHTML` on every commit of an element, and the live-commit
 * re-renders fire one commit per keystroke — a React-owned content prop would
 * overwrite the user's typing and reset the caret to the start every keystroke.
 * The canvas seeds the content imperatively instead, via
 * `seedInlineEditableContent`.
 */
import { describe, it, expect } from 'bun:test'
import { createRef } from 'react'
import {
  inlineEditableElementProps,
  seedInlineEditableContent,
} from '@modules/base/shared/inlineText'
import type { InlineEditBinding } from '@core/module-engine'

function makeBinding(initialValue: string): InlineEditBinding {
  return {
    ref: createRef<HTMLElement>(),
    initialValue,
    onInput: () => {},
    onKeyDown: () => {},
    onBlur: () => {},
  }
}

describe('inlineEditableElementProps', () => {
  it('makes the element a plaintext-only contentEditable surface', () => {
    const props = inlineEditableElementProps(makeBinding('A\nB'))
    expect(props.contentEditable).toBe('plaintext-only')
    expect(props.suppressContentEditableWarning).toBe(true)
  })

  it('wires through the binding ref and the three live-edit handlers', () => {
    const binding = makeBinding('A\nB')
    const props = inlineEditableElementProps(binding)
    expect(props.ref).toBe(binding.ref)
    expect(props.onInput).toBe(binding.onInput)
    expect(props.onKeyDown).toBe(binding.onKeyDown)
    expect(props.onBlur).toBe(binding.onBlur)
  })

  it('does NOT hand React the content (no dangerouslySetInnerHTML, no children)', () => {
    // Regression guard: React owning the content re-applies it every keystroke,
    // wiping the edit and collapsing the caret. The content is seeded
    // imperatively instead.
    const props = inlineEditableElementProps(makeBinding('A\nB')) as Record<string, unknown>
    expect('dangerouslySetInnerHTML' in props).toBe(false)
    expect('children' in props).toBe(false)
  })
})

describe('seedInlineEditableContent', () => {
  it('seeds the element from initialValue with newlines as <br>', () => {
    const el = document.createElement('h1')
    seedInlineEditableContent(el, 'A\nB')
    expect(el.innerHTML).toBe('A<br>B')
  })

  it('escapes HTML special chars in the seeded content (no injection)', () => {
    const el = document.createElement('h1')
    seedInlineEditableContent(el, '<b>x</b>\n&y')
    expect(el.innerHTML).toBe('&lt;b&gt;x&lt;/b&gt;<br>&amp;y')
    expect(el.querySelector('b')).toBeNull()
  })
})
