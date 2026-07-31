import { describe, expect, test } from 'bun:test'
import { INTERRUPTED_TOOL_RESULT_ERROR } from '@core/ai'
import type { AiProvider, AiStreamRequest } from '../../../server/ai/drivers/types'
import type { ConversationsPersister } from '../../../server/ai/runtime/persister'
import { runChat } from '../../../server/ai/runtime/runner'
import type { AiStreamEvent } from '../../../server/ai/runtime/types'

function request(signal: AbortSignal): AiStreamRequest {
  return {
    systemPrompt: [],
    messages: [],
    tools: [],
    modelId: 'test-model',
    modelCapabilities: {
      toolCalling: true,
      visionInput: false,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    },
    credentials: {
      id: 'credential-1',
      providerId: 'ollama',
      authMode: 'baseUrl',
      apiKey: null,
      baseUrl: 'http://localhost:11434',
    },
    signal,
    bridge: {
      async callBrowser() {
        return { ok: true }
      },
    },
    toolContextBase: {
      db: {} as never,
      userId: 'user-1',
      capabilities: [],
      scope: 'site',
      conversationId: 'conversation-1',
      snapshot: null,
    },
  }
}

function provider(
  stream: AiProvider['stream'],
): AiProvider {
  return {
    id: 'ollama',
    label: 'Test provider',
    supportedAuthModes: ['baseUrl'],
    capabilities: () => ({
      toolCalling: true,
      visionInput: false,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    }),
    async listModels() {
      return []
    },
    stream,
  }
}

function persister(onToolCall?: () => void): {
  value: ConversationsPersister
  results: Array<Parameters<ConversationsPersister['appendToolResult']>[0]>
} {
  const results: Array<Parameters<ConversationsPersister['appendToolResult']>[0]> = []
  return {
    results,
    value: {
      async appendAssistantText() {},
      async appendToolCall() {
        onToolCall?.()
      },
      async appendToolResult(result) {
        results.push(result)
      },
      async recordUsage() {
        return 0
      },
      recordContext() {},
    },
  }
}

describe('runChat pending tool finalization', () => {
  test('persists an interrupted result when a graceful abort ends the turn', async () => {
    const controller = new AbortController()
    const toolCallPersisted = deferred<void>()
    const stored = persister(() => toolCallPersisted.resolve())
    const emitted: AiStreamEvent[] = []
    const driver = provider(async function* (req) {
      yield {
        type: 'toolCall',
        toolCallId: 'tool-1',
        toolName: 'site_render_snapshot',
        input: {},
        status: 'pending',
      }
      await untilAborted(req.signal)
    })

    const running = runChat({
      driver,
      request: request(controller.signal),
      persister: stored.value,
      emit(event) {
        emitted.push(event)
      },
    })
    await toolCallPersisted.promise
    controller.abort()
    await running

    expect(stored.results).toEqual([{
      toolCallId: 'tool-1',
      toolName: 'site_render_snapshot',
      ok: false,
      error: INTERRUPTED_TOOL_RESULT_ERROR,
    }])
    expect(emitted.map((event) => event.type)).toEqual([
      'toolCall',
      'toolResult',
      'done',
    ])
  })

  test('emits the interrupted result before a terminal driver error', async () => {
    const stored = persister()
    const emitted: AiStreamEvent[] = []
    const driver = provider(async function* () {
      yield {
        type: 'toolCall',
        toolCallId: 'tool-2',
        toolName: 'site_apply_css',
        input: {},
        status: 'pending',
      }
      yield { type: 'error', message: 'Provider stream failed.' }
    })

    await runChat({
      driver,
      request: request(new AbortController().signal),
      persister: stored.value,
      emit(event) {
        emitted.push(event)
      },
    })

    expect(stored.results).toHaveLength(1)
    expect(emitted.map((event) => event.type)).toEqual([
      'toolCall',
      'toolResult',
      'error',
    ])
    expect(emitted.at(-1)).toEqual({ type: 'error', message: 'Provider stream failed.' })
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
