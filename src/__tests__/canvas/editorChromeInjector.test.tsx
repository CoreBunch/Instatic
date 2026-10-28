/**
 * Regression guard: the editor-chrome injector must NOT overwrite the site's
 * own Framework tokens on the iframe `:root`.
 *
 * The injector is unlayered, so anything it sets on `:root` beats the site's
 * Framework tokens (which live in `@layer user-authored`). It used to copy
 * admin tokens straight onto the iframe root, silently rendering canvas
 * content with editor token values instead of the site's configured ones.
 * Editor chrome must ride chrome-namespaced variables instead.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { render, cleanup } from '@testing-library/react'
import { EditorChromeInjector } from '@site/canvas/EditorChromeInjector'

afterEach(cleanup)

/** A detached document whose :root carries admin typography and spacing tokens. */
function makeParentDoc(): Document {
  document.documentElement.style.setProperty('--font-sans', '"Inter Variable", system-ui, sans-serif')
  document.documentElement.style.setProperty('--text-xs', 'clamp(10px, calc(9.629px + 0.095vw), 11px)')
  document.documentElement.style.setProperty('--text-s', 'clamp(11px, calc(10.629px + 0.095vw), 12px)')
  document.documentElement.style.setProperty('--space-s', 'clamp(6px, calc(5.257px + 0.19vw), 8px)')
  document.documentElement.style.setProperty('--space-xl', 'clamp(12px, calc(11.257px + 0.19vw), 14px)')
  return document
}

describe('EditorChromeInjector font isolation', () => {
  it('forwards editor chrome tokens under chrome-namespaced variables, never site Framework tokens', () => {
    const target = document.implementation.createHTMLDocument('iframe')
    render(<EditorChromeInjector targetDocument={target} parentDocument={makeParentDoc()} />)

    const css = target.getElementById('instatic-editor-chrome')?.textContent ?? ''
    expect(css).not.toBe('')

    // The chrome font is exposed as a namespaced var carrying the editor font…
    expect(css).toContain('--chrome-font-sans: "Inter Variable", system-ui, sans-serif;')
    // …and chrome rules reference it.
    expect(css).toContain('font-family: var(--chrome-font-sans);')
    expect(css).toContain('--chrome-text-xs: clamp(10px, calc(9.629px + 0.095vw), 11px);')
    expect(css).toContain('--chrome-text-s: clamp(11px, calc(10.629px + 0.095vw), 12px);')
    expect(css).toContain('font-size: var(--chrome-text-s);')
    expect(css).toContain('font-size: var(--chrome-text-xs);')
    expect(css).toContain('--chrome-space-s: clamp(6px, calc(5.257px + 0.19vw), 8px);')
    expect(css).toContain('--chrome-space-xl: clamp(12px, calc(11.257px + 0.19vw), 14px);')
    expect(css).toContain('gap: var(--chrome-space-s);')
    expect(css).toContain('padding: var(--chrome-space-xl);')

    // It must NEVER set the site's own Framework tokens on :root, nor
    // reference them — doing so clobbers token values for all canvas content.
    expect(css).not.toMatch(/^\s*--font-sans:/m)
    expect(css).not.toContain('var(--font-sans)')
    expect(css).not.toMatch(/^\s*--text-s:/m)
    expect(css).not.toMatch(/^\s*--text-xs:/m)
    expect(css).not.toContain('var(--text-s)')
    expect(css).not.toContain('var(--text-xs)')
    expect(css).not.toMatch(/^\s*--space-s:/m)
    expect(css).not.toMatch(/^\s*--space-xl:/m)
    expect(css).not.toContain('var(--space-s)')
    expect(css).not.toContain('var(--space-xl)')
  })
})

/**
 * Regression guard: no admin token may be declared on the iframe `:root` under
 * its own name.
 *
 * The chrome stylesheet is unlayered and the site's CSS sits in
 * `@layer user-authored`, so any custom property the chrome declares wins over
 * the site's declaration of the same name. A site with `:root { --radius: 12px }`
 * or its own `--text` rendered with the editor's 6px radius and text colour in
 * the canvas, while the published page used the site's values. Every token the
 * chrome declares or reads must live under the reserved `--chrome-` namespace.
 */
describe('EditorChromeInjector token namespace', () => {
  it('declares and reads only chrome-namespaced custom properties', () => {
    const root = document.documentElement
    root.style.setProperty('--radius', '6px')
    root.style.setProperty('--text', 'rgb(230, 230, 230)')
    root.style.setProperty('--text-subtle', 'rgb(120, 120, 120)')
    root.style.setProperty('--bg-surface', 'rgb(30, 30, 30)')
    root.style.setProperty('--canvas-placeholder-bg', 'rgb(40, 40, 40)')

    const target = document.implementation.createHTMLDocument('iframe')
    render(<EditorChromeInjector targetDocument={target} parentDocument={document} />)
    const css = target.getElementById('instatic-editor-chrome')?.textContent ?? ''

    const declared = Array.from(css.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1])
    const read = Array.from(css.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    expect(read.length).toBeGreaterThan(0)
    expect(declared.filter((name) => !name.startsWith('--chrome-'))).toEqual([])
    expect(read.filter((name) => !name.startsWith('--chrome-'))).toEqual([])

    // Admin values still reach the chrome, under the namespaced names.
    expect(css).toContain('--chrome-radius: 6px;')
    expect(css).toContain('--chrome-text: rgb(230, 230, 230);')
    expect(css).toContain('--chrome-text-subtle: rgb(120, 120, 120);')
    expect(css).toContain('border-radius: var(--chrome-radius);')
    expect(css).toContain('background: var(--chrome-canvas-placeholder-bg);')
  })
})
