import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { highlightingFor } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { readFileSync } from 'node:fs'
import CodeMirrorEditor from '@site/code-editor/CodeMirrorEditor'
import type { SiteFile } from '@core/files/schemas'

afterEach(cleanup)

const cssFile = {
  id: 'root-css',
  path: 'src/styles/root.css',
  type: 'style',
  content: '#root {\n  --var: red;\n}\n',
  createdAt: 1,
  updatedAt: 1,
} satisfies SiteFile

function waitForCodeMirrorMount() {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

function styleRuleForClass(className: string): CSSStyleRule | null {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if ('selectorText' in rule && rule.selectorText === `.${className}`) {
        return rule as CSSStyleRule
      }
    }
  }

  return null
}

function highlightedColorFor(view: EditorView, tag: typeof tags.labelName) {
  const className = highlightingFor(view.state, [tag])
  expect(className).toBeTruthy()

  const rule = styleRuleForClass(className!)
  expect(rule).toBeTruthy()

  return rule!.style.color
}

describe('CodeMirrorEditor theme', () => {
  it('uses GitHub Dark-style syntax colors for CSS tokens', async () => {
    render(
      <CodeMirrorEditor
        docKey={cssFile.id}
        value={cssFile.content}
        language="css"
        onChange={() => {}}
      />,
    )
    await waitForCodeMirrorMount()

    const editor = document.querySelector<HTMLElement>('.cm-editor')
    expect(editor).toBeTruthy()

    const view = EditorView.findFromDOM(editor!)
    expect(view).toBeTruthy()

    expect(highlightedColorFor(view!, tags.labelName)).toBe('var(--syntax-entity)')
    expect(highlightedColorFor(view!, tags.className)).toBe('var(--syntax-entity)')
    expect(highlightedColorFor(view!, tags.propertyName)).toBe('var(--syntax-property)')
    expect(highlightedColorFor(view!, tags.variableName)).toBe('var(--syntax-variable)')
    expect(highlightedColorFor(view!, tags.atom)).toBe('var(--syntax-constant)')
  })

  it('defines the GitHub Dark syntax palette as editor design tokens', () => {
    const globals = readFileSync(
      new URL('../../styles/globals.css', import.meta.url),
      'utf8',
    )

    expect(globals).toContain('--syntax-keyword: #ff7b72;')
    expect(globals).toContain('--syntax-entity: #d2a8ff;')
    expect(globals).toContain('--syntax-property: #7ee787;')
    expect(globals).toContain('--syntax-variable: #ffa657;')
    expect(globals).toContain('--syntax-string: #a5d6ff;')
    expect(globals).toContain('--syntax-constant: #79c0ff;')
    expect(globals).toContain('--syntax-comment: #8b949e;')
  })
})
