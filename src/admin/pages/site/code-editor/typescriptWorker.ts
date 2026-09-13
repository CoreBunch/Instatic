import { safeParseValue } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { TypeScriptLanguageServiceEngine } from './typescriptLanguageServiceEngine'
import {
  TypeScriptWorkerRequestSchema,
  type TypeScriptWorkerResponse,
} from './typescriptProtocol'

const libraries = import.meta.glob<string>(
  '/node_modules/typescript/lib/lib.*.d.ts',
  { eager: true, import: 'default', query: '?raw' },
)

const engine = new TypeScriptLanguageServiceEngine(libraries)

function respond(response: TypeScriptWorkerResponse): void {
  self.postMessage(response)
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const parsed = safeParseValue(TypeScriptWorkerRequestSchema, event.data)
  if (!parsed.ok) {
    console.warn('[typescript-worker] Ignored an invalid language-service request.')
    return
  }

  const request = parsed.value
  try {
    switch (request.type) {
      case 'sync':
        engine.sync(request.files)
        break
      case 'update':
        engine.update(request.path, request.content)
        break
      case 'diagnostics':
        respond({
          type: 'diagnostics',
          requestId: request.requestId,
          diagnostics: engine.diagnostics(request.path),
        })
        break
      case 'completions':
        respond({
          type: 'completions',
          requestId: request.requestId,
          result: engine.completions(request.path, request.position),
        })
        break
      case 'hover':
        respond({
          type: 'hover',
          requestId: request.requestId,
          result: engine.hover(request.path, request.position),
        })
        break
    }
  } catch (error) {
    if ('requestId' in request) {
      respond({
        type: 'error',
        requestId: request.requestId,
        message: getErrorMessage(error, 'TypeScript language service failed'),
      })
      return
    }
    console.error('[typescript-worker] Failed to synchronize the TypeScript project:', error)
  }
})
