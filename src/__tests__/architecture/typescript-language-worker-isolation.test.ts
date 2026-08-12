import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const editorFile = (name: string) => readFileSync(
  new URL(`../../admin/pages/site/code-editor/${name}`, import.meta.url),
  'utf8',
)

describe('TypeScript language-service worker isolation', () => {
  it('keeps the compiler behind a dedicated browser worker', () => {
    const client = editorFile('typescriptLanguageClient.ts')
    const worker = editorFile('typescriptWorker.ts')
    const engine = editorFile('typescriptLanguageServiceEngine.ts')
    const editor = editorFile('CodeMirrorEditor.tsx')

    expect(client).toContain("new Worker(new URL('./typescriptWorker.ts', import.meta.url)")
    expect(worker).toContain("from './typescriptLanguageServiceEngine'")
    expect(engine).toContain("from 'typescript'")
    expect(client).not.toContain("from 'typescript'")
    expect(editor).not.toContain("from 'typescript'")
  })

  it('loads TypeScript standard libraries inside the worker bundle', () => {
    const worker = editorFile('typescriptWorker.ts')
    expect(worker).toContain("'/node_modules/typescript/lib/lib.*.d.ts'")
    expect(worker).toContain("query: '?raw'")
  })

  it('constrains language tooltips to the editor instead of the viewport', () => {
    const editor = editorFile('CodeMirrorEditor.tsx')
    expect(editor).toContain('const editorTooltipBoundary = tooltips({')
    expect(editor).toContain('tooltipSpace: (view) => view.dom.getBoundingClientRect()')
    expect(editor).toContain('editorTooltipBoundary,')
  })
})
