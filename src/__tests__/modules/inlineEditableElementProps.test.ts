/**
 * inlineEditableElementProps — the prop bag a text module spreads onto its own
 * element so the element BECOMES the inline editor.
 *
 * The element is made `contentEditable=plaintext-only` (no rich formatting /
 * pasted markup), the three live-edit handlers are wired through, and the
 * content is seeded ONCE from the binding's `initialValue` via
 * `dangerouslySetInnerHTML` — escaped first, so `\n` → `<br>` is the ONLY
 * markup that can reach the DOM (never user-injected HTML).
 */
import { describe, it, expect } from 'bun:test'
import { createRef } from 'react'
import { inlineEditableElementProps } from '@modules/base/shared/inlineText'
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

  it('seeds the content from initialValue with newlines as <br>', () => {
    const props = inlineEditableElementProps(makeBinding('A\nB'))
    expect(props.dangerouslySetInnerHTML.__html).toBe('A<br>B')
  })

  it('escapes HTML special chars in the seeded content (no injection)', () => {
    const props = inlineEditableElementProps(makeBinding('<b>x</b>\n&y'))
    expect(props.dangerouslySetInnerHTML.__html).toBe('&lt;b&gt;x&lt;/b&gt;<br>&amp;y')
    expect(props.dangerouslySetInnerHTML.__html).not.toContain('<b>')
  })
})
