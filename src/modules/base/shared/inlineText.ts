/**
 * Shared helpers for text modules that support hard line breaks (`base.text`,
 * `base.button`, `base.link`).
 *
 * The stored value keeps newlines as `\n`. Both render surfaces turn each `\n`
 * into a `<br>` so a hard break shows live in the canvas AND survives publish
 * (the publisher's DOMPurify pass allows `<br>`). This is what makes inline
 * editing's Enter-key behaviour faithful: a break the author types is a break
 * everywhere.
 *
 * Two entry points because the two surfaces escape differently:
 *   - `textToBreakHtml` — for the publisher, whose `escapeProps` has ALREADY
 *     HTML-escaped the prop value, so we only insert the `<br>`s.
 *   - `rawTextToBreakHtml` — for the canvas (`dangerouslySetInnerHTML`), which
 *     receives the RAW stored value, so we escape first, then insert `<br>`s.
 */
import type { InlineEditBinding } from '@core/module-engine'
import { escapeHtml } from '@modules/base/utils/escape'

/** `\n` → `<br>` on an already-escaped string (publisher render path). */
export function textToBreakHtml(escapedText: string): string {
  return escapedText.replace(/\n/g, '<br>')
}

/** Escape a raw stored value, then `\n` → `<br>` (canvas render path). */
export function rawTextToBreakHtml(rawText: string): string {
  return escapeHtml(rawText).replace(/\n/g, '<br>')
}

/**
 * Read the edited text back out of a `contentEditable` element. `innerText`
 * resolves `<br>` and block boundaries to `\n` and applies the element's own
 * `white-space` rules — so what we store matches exactly what the element
 * shows. (`textContent` would drop `<br>` breaks entirely.)
 */
export function readInlineEditableText(el: HTMLElement): string {
  return el.innerText
}

/**
 * Props a text module spreads onto its element to BECOME the inline editor.
 * The element is `contentEditable` (plaintext-only — no rich formatting or
 * pasted markup) and carries the live-edit handlers + ref.
 *
 * Critically it provides NEITHER `dangerouslySetInnerHTML` NOR children: React
 * must not own the element's content while it is being edited. React 19
 * re-applies `dangerouslySetInnerHTML` on EVERY commit of an element (it does
 * not skip on an unchanged `__html`), and the live-commit re-renders fire one
 * commit per keystroke — so a React-owned content prop would overwrite the
 * user's typing and collapse the caret to the start every keystroke. Instead
 * the canvas seeds the element's content imperatively once (see
 * `seedInlineEditableContent`) and React leaves the contentEditable DOM alone.
 *
 * The module must render NO children alongside these props.
 */
export function inlineEditableElementProps(binding: InlineEditBinding) {
  return {
    ref: binding.ref,
    // `plaintext-only` keeps the surface a pure text field — Cmd+B, pasted
    // HTML, etc. can't introduce formatting. React's DOM types accept it.
    contentEditable: 'plaintext-only' as const,
    suppressContentEditableWarning: true,
    spellCheck: false,
    onInput: binding.onInput,
    onKeyDown: binding.onKeyDown,
    onBlur: binding.onBlur,
  }
}

/**
 * Seed the inline-editor element's content from the session's initial value,
 * imperatively (NOT through React). The value is HTML-escaped, so the only
 * markup is the `<br>`s we insert from newlines — never user HTML. Call once,
 * when the session opens, before placing the caret.
 */
export function seedInlineEditableContent(el: HTMLElement, initialValue: string): void {
  el.innerHTML = rawTextToBreakHtml(initialValue)
}
