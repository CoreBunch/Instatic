import { afterEach, describe, expect, it } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { TypeScriptLanguageServiceEngine } from '@site/code-editor/typescriptLanguageServiceEngine'
import {
  createTypeScriptLanguageClient,
  TypeScriptLanguageClient,
} from '@site/code-editor/typescriptLanguageClient'
import type {
  TypeScriptWorkerRequest,
  TypeScriptWorkerResponse,
} from '@site/code-editor/typescriptProtocol'

function loadTypeScriptLibraries(): Record<string, string> {
  const typescriptDirectory = dirname(fileURLToPath(import.meta.resolve('typescript')))
  const libraries: Record<string, string> = {}
  const seen = new Set<string>()

  function load(name: string): void {
    if (seen.has(name)) return
    seen.add(name)
    const content = readFileSync(join(typescriptDirectory, name), 'utf8')
    libraries[name] = content
    for (const match of content.matchAll(/<reference lib="([^"]+)"/g)) {
      load(`lib.${match[1]}.d.ts`)
    }
  }

  load('lib.es2020.full.d.ts')
  return libraries
}

const engines: TypeScriptLanguageServiceEngine[] = []

function createEngine(): TypeScriptLanguageServiceEngine {
  const engine = new TypeScriptLanguageServiceEngine(loadTypeScriptLibraries())
  engines.push(engine)
  return engine
}

afterEach(() => {
  while (engines.length > 0) engines.pop()!.dispose()
})

describe('TypeScriptLanguageServiceEngine', () => {
  it('provides DOM-aware diagnostics, completions, and hover information', () => {
    const engine = createEngine()
    const content = [
      'const title: number = document.title',
      'window.loc',
    ].join('\n')
    engine.sync([{ path: 'src/scripts/main.ts', content }])

    expect(engine.diagnostics('src/scripts/main.ts')).toContainEqual(expect.objectContaining({
      code: 2322,
      message: "Type 'string' is not assignable to type 'number'.",
      line: 1,
      column: 6,
    }))
    expect(
      engine.completions('src/scripts/main.ts', content.length)?.options.map((option) => option.label),
    ).toContain('location')
    expect(engine.hover('src/scripts/main.ts', content.indexOf('document') + 2)).toEqual(
      expect.objectContaining({ signature: 'var document: Document' }),
    )
  })

  it('shares authored types across relative imports while leaving package resolution to the runtime', () => {
    const engine = createEngine()
    engine.sync([
      {
        path: 'src/scripts/types.ts',
        content: 'export interface User { name: string }',
      },
      {
        path: 'src/scripts/main.ts',
        content: [
          "import type { User } from './types'",
          "import confetti from 'canvas-confetti'",
          "const user: User = { name: 42 }",
          'void confetti',
        ].join('\n'),
      },
    ])

    const diagnostics = engine.diagnostics('src/scripts/main.ts')
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 2322 }))
    expect(diagnostics.some((diagnostic) => diagnostic.code === 2307)).toBe(false)

    engine.update(
      'src/scripts/main.ts',
      "import type { Missing } from './missing'\nconst value: Missing = {}",
    )
    expect(engine.diagnostics('src/scripts/main.ts')).toContainEqual(expect.objectContaining({
      code: 2307,
      message: "Cannot find module './missing' or its corresponding type declarations.",
    }))
  })
})

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  requests: TypeScriptWorkerRequest[] = []
  terminated = false

  postMessage(request: TypeScriptWorkerRequest): void {
    this.requests.push(request)
    if (!('requestId' in request)) return
    let response: TypeScriptWorkerResponse
    if (request.type === 'diagnostics') {
      response = { type: 'diagnostics', requestId: request.requestId, diagnostics: [] }
    } else if (request.type === 'completions') {
      response = {
        type: 'completions',
        requestId: request.requestId,
        result: { from: request.position, to: request.position, options: [] },
      }
    } else {
      response = { type: 'hover', requestId: request.requestId }
    }
    queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: response })))
  }

  terminate(): void {
    this.terminated = true
  }
}

describe('TypeScriptLanguageClient', () => {
  it('does not treat Bun\'s process-global Worker as a browser worker', () => {
    const originalWindowWorker = window.Worker
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      writable: true,
      value: undefined,
    })

    try {
      expect(typeof globalThis.Worker).toBe('function')
      expect(createTypeScriptLanguageClient()).toBeNull()
    } finally {
      Object.defineProperty(window, 'Worker', {
        configurable: true,
        writable: true,
        value: originalWindowWorker,
      })
    }
  })

  it('correlates validated worker responses and terminates cleanly', async () => {
    const worker = new FakeWorker()
    const client = new TypeScriptLanguageClient(() => worker)
    client.syncProject([{ path: 'src/scripts/main.ts', content: 'window.location' }])
    client.updateFile('src/scripts/main.ts', 'window.document')

    expect(await client.diagnostics('src/scripts/main.ts')).toEqual([])
    expect(await client.completions('src/scripts/main.ts', 5)).toEqual({
      from: 5,
      to: 5,
      options: [],
    })
    expect(await client.hover('src/scripts/main.ts', 2)).toBeUndefined()
    expect(worker.requests.map((request) => request.type)).toEqual([
      'sync',
      'update',
      'diagnostics',
      'completions',
      'hover',
    ])

    client.dispose()
    expect(worker.terminated).toBe(true)
  })
})
