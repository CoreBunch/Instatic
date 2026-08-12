import { safeParseValue } from '@core/utils/typeboxHelpers'
import {
  TypeScriptWorkerResponseSchema,
  type TypeScriptCompletionResult,
  type TypeScriptEditorDiagnostic,
  type TypeScriptHoverResult,
  type TypeScriptProjectFile,
  type TypeScriptWorkerRequest,
  type TypeScriptWorkerResponse,
} from './typescriptProtocol'

interface TypeScriptWorkerTransport {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: TypeScriptWorkerRequest): void
  terminate(): void
}

export type TypeScriptWorkerFactory = () => TypeScriptWorkerTransport

interface PendingRequest {
  resolve: (response: TypeScriptWorkerResponse) => void
  reject: (error: Error) => void
}

type TypeScriptAsyncRequest =
  | { type: 'diagnostics'; path: string }
  | { type: 'completions'; path: string; position: number }
  | { type: 'hover'; path: string; position: number }

function defaultWorkerFactory(): TypeScriptWorkerTransport {
  return new Worker(new URL('./typescriptWorker.ts', import.meta.url), {
    name: 'instatic-typescript',
    type: 'module',
  })
}

export class TypeScriptLanguageClient {
  private readonly worker: TypeScriptWorkerTransport
  private readonly pending = new Map<string, PendingRequest>()
  private nextRequestId = 1
  private disposed = false

  constructor(workerFactory: TypeScriptWorkerFactory = defaultWorkerFactory) {
    this.worker = workerFactory()
    this.worker.onmessage = (event) => this.handleMessage(event.data)
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'TypeScript worker failed')
      console.error('[CodeMirrorEditor] TypeScript worker error:', error)
      this.disposed = true
      this.worker.terminate()
      this.rejectPending(error)
    }
  }

  syncProject(files: TypeScriptProjectFile[]): void {
    if (this.disposed) return
    this.worker.postMessage({ type: 'sync', files })
  }

  updateFile(path: string, content: string): void {
    if (this.disposed) return
    this.worker.postMessage({ type: 'update', path, content })
  }

  async diagnostics(path: string): Promise<TypeScriptEditorDiagnostic[]> {
    const response = await this.request({ type: 'diagnostics', path })
    if (response.type !== 'diagnostics') throw new Error('Unexpected TypeScript diagnostics response')
    return response.diagnostics
  }

  async completions(path: string, position: number): Promise<TypeScriptCompletionResult | undefined> {
    const response = await this.request({ type: 'completions', path, position })
    if (response.type !== 'completions') throw new Error('Unexpected TypeScript completions response')
    return response.result
  }

  async hover(path: string, position: number): Promise<TypeScriptHoverResult | undefined> {
    const response = await this.request({ type: 'hover', path, position })
    if (response.type !== 'hover') throw new Error('Unexpected TypeScript hover response')
    return response.result
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker.terminate()
    this.rejectPending(new Error('TypeScript language service was closed'))
  }

  private request(
    request: TypeScriptAsyncRequest,
  ): Promise<TypeScriptWorkerResponse> {
    if (this.disposed) return Promise.reject(new Error('TypeScript language service is closed'))
    const requestId = String(this.nextRequestId++)
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.worker.postMessage({ ...request, requestId })
    })
  }

  private handleMessage(value: unknown): void {
    const parsed = safeParseValue(TypeScriptWorkerResponseSchema, value)
    if (!parsed.ok) {
      const error = new Error('TypeScript worker returned an invalid response')
      console.error('[CodeMirrorEditor] Invalid TypeScript worker response:', error)
      this.rejectPending(error)
      return
    }
    const response = parsed.value
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (response.type === 'error') {
      pending.reject(new Error(response.message))
      return
    }
    pending.resolve(response)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export function createTypeScriptLanguageClient(
  workerFactory?: TypeScriptWorkerFactory,
): TypeScriptLanguageClient | null {
  if (!workerFactory && typeof Worker === 'undefined') return null
  return new TypeScriptLanguageClient(workerFactory)
}
