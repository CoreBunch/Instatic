import { describe, test, expect, afterEach } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import { opencodeDriver } from '../../../server/ai/drivers/opencode'
import type { AiStreamRequest } from '../../../server/ai/drivers/types'
import type { AiBrowserBridge, AiStreamEvent, AiTool } from '../../../server/ai/runtime/types'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('opencodeDriver', () => {
  test('lists OpenCode Zen models with catalogue pricing, context, and capabilities', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://opencode.ai/zen/v1/models')
      expect(init?.headers).toEqual({ Authorization: 'Bearer oc-test' })
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'mimo-v2.5-free',
              name: 'MiMo V2.5 Free',
              capabilities: { toolcall: true, input: { image: true } },
              cost: { input: 0, output: 0 },
              limit: { context: 200000 },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const models = await opencodeDriver.listModels({
      id: 'cred',
      providerId: 'opencode',
      authMode: 'apiKey',
      apiKey: 'oc-test',
      baseUrl: null,
    })

    expect(models).toEqual([
      {
        id: 'mimo-v2.5-free',
        label: 'MiMo V2.5 Free',
        catalogueSource: 'live',
        capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        contextWindow: 200000,
      },
    ])
  })

  test('streams via OpenCode Zen chat/completions and sends tools as JSON Schema', async () => {
    const calls: unknown[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      expect(String(input)).toBe('https://opencode.ai/zen/v1/chat/completions')
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"zen reply"},"finish_reason":"stop"}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}',
          'data: [DONE]',
          '',
        ].join('\n\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch

    const tool: AiTool = {
      name: 'insertHtml',
      description: 'Insert HTML',
      scope: 'site',
      execution: 'server',
      inputSchema: Type.Object({ html: Type.String() }),
    }
    const bridge: AiBrowserBridge = { callBrowser: async () => ({ ok: true, data: {} }) }
    const req: AiStreamRequest = {
      systemPrompt: ['SYS'],
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
      tools: [tool],
      modelId: 'mimo-v2.5-free',
      modelCapabilities: {
        toolCalling: true,
        visionInput: false,
        promptCache: false,
        streaming: true,
      },
      credentials: {
        id: 'cred',
        providerId: 'opencode',
        authMode: 'apiKey',
        apiKey: 'oc-test',
        baseUrl: null,
      },
      signal: new AbortController().signal,
      bridge,
      toolContextBase: {
        db: {} as AiStreamRequest['toolContextBase']['db'],
        userId: 'u1',
        capabilities: [],
        scope: 'site',
        conversationId: 'c1',
        snapshot: null,
      },
    }

    const events: AiStreamEvent[] = []
    for await (const ev of opencodeDriver.stream(req)) events.push(ev)

    expect(events).toEqual([
      { type: 'text', text: 'zen reply' },
      { type: 'context', promptTokens: 11, cacheReadTokens: undefined, cacheCreationTokens: undefined },
      {
        type: 'usage',
        promptTokens: 11,
        completionTokens: 3,
        costUsd: undefined,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
      },
    ])
    expect(calls).toHaveLength(1)
    const body = JSON.parse((calls[0] as { init: RequestInit }).init.body as string)
    expect(body).toMatchObject({
      model: 'mimo-v2.5-free',
      stream: true,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'insertHtml',
            description: 'Insert HTML',
            parameters: { type: 'object' },
          },
        },
      ],
    })
  })
})
