/**
 * Regression guard: the editor-chrome injector must NOT overwrite the site's
 * own `--font-sans` on the iframe `:root`.
 *
 * The injector is unlayered, so anything it sets on `:root` beats the site's
 * font tokens (which live in `@layer user-authored`). It used to copy the
 * admin `--font-sans` straight onto the iframe root, silently rendering every
 * canvas element in the editor's font instead of the site's configured one —
 * and making parent-doc overlays (the inline text-edit field) mismatch. The
 * editor font must ride a chrome-namespaced variable instead.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { render, cleanup } from '@testing-library/react'
import { EditorChromeInjector } from '@site/canvas/EditorChromeInjector'

afterEach(cleanup)

/** A detached document whose :root carries the admin `--font-sans`. */
function makeParentDoc(): Document {
  document.documentElement.style.setProperty('--font-sans', '"Inter Variable", system-ui, sans-serif')
  return document
}

describe('EditorChromeInjector font isolation', () => {
  it('forwards the editor font under a chrome-namespaced variable, never the site --font-sans', () => {
    const target = document.implementation.createHTMLDocument('iframe')
    render(<EditorChromeInjector targetDocument={target} parentDocument={makeParentDoc()} />)

    const css = target.getElementById('instatic-editor-chrome')?.textContent ?? ''
    expect(css).not.toBe('')

    // The chrome font is exposed as a namespaced var carrying the editor font…
    expect(css).toContain('--editor-chrome-font-sans: "Inter Variable", system-ui, sans-serif;')
    // …and chrome rules reference it.
    expect(css).toContain('font-family: var(--editor-chrome-font-sans);')

    // It must NEVER set the site's own --font-sans on :root, nor reference it —
    // doing so clobbers the site's font tokens for all canvas content.
    expect(css).not.toMatch(/^\s*--font-sans:/m)
    expect(css).not.toContain('var(--font-sans)')
  })
})
