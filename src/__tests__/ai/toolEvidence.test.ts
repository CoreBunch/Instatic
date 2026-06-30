import { describe, test, expect, afterEach } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import { anthropicDriver } from '../../../server/ai/drivers/anthropic'
import { ollamaDriver } from '../../../server/ai/drivers/ollama'
import type { AiStreamRequest } from '../../../server/ai/drivers/types'
import type {
  AiBrowserBridge,
  AiProviderCapabilities,
  AiStreamEvent,
  AiTool,
  AiToolOutput,
} from '../../../server/ai/runtime/types'

/**
 * Covers the heavy-evidence handling added to the shared tool loop:
 *   1. A tool result with an image attachment becomes a NATIVE Anthropic image
 *      block in the tool_result (not base64-as-JSON-text).
 *   2. `site_render_snapshot` gets `captureScreenshot` injected from the model's
 *      vision capability — never set by the model.
 *   3. Superseded heavy results (an earlier `site_render_snapshot`) are stubbed in
 *      the replayed history so context can't balloon.
 *   4. Text-only providers (Ollama/OpenAI-compatible) drop the image with a
 *      one-line note instead of carrying it.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function sse(...events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function sseResponse(body: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function anthropicSnapTurn(id: string): string {
  return sse(
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'site_render_snapshot', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  )
}

const ANTHROPIC_DONE = sse(
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
)

const VISION_CAPS: AiProviderCapabilities = { toolCalling: true, visionInput: true, promptCache: true, streaming: true }
const NO_VISION_CAPS: AiProviderCapabilities = { toolCalling: true, visionInput: false, promptCache: false, streaming: true }

const renderSnapshotTool: AiTool = {
  name: 'site_render_snapshot',
  description: 'snapshot',
  scope: 'site',
  execution: 'browser',
  inputSchema: Type.Object({
    breakpointId: Type.Optional(Type.String()),
    captureScreenshot: Type.Optional(Type.Boolean()),
  }),
}

function makeRequest(
  bridge: AiBrowserBridge,
  caps: AiProviderCapabilities,
  overrides: Partial<AiStreamRequest> = {},
): AiStreamRequest {
  return {
    systemPrompt: ['You are a test.'],
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
    tools: [renderSnapshotTool],
    modelId: 'claude-sonnet-4-6',
    modelCapabilities: caps,
    credentials: { id: 'cr', providerId: 'anthropic', authMode: 'apiKey', apiKey: 'sk-test', baseUrl: null },
    signal: new AbortController().signal,
    bridge,
    toolContextBase: { db: {} as never, userId: 'u1', scope: 'site', conversationId: 'c1', snapshot: {} },
    ...overrides,
  }
}

const screenshotOutput: AiToolOutput = {
  ok: true,
  data: { layout: { warnings: [] } },
  images: [{ mimeType: 'image/png', data: 'QUJD' }],
}

describe('multimodal tool output + heavy elision (Anthropic)', () => {
  test('injects captureScreenshot from vision capability and forwards the image as a native block', async () => {
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return sseResponse(bodies.length === 1 ? anthropicSnapTurn('t_s1') : ANTHROPIC_DONE)
    }) as typeof fetch

    const browserInputs: unknown[] = []
    const bridge: AiBrowserBridge = {
      async callBrowser(_name, input): Promise<AiToolOutput> {
        browserInputs.push(input)
        return screenshotOutput
      },
    }

    const events: AiStreamEvent[] = []
    for await (const ev of anthropicDriver.stream(makeRequest(bridge, VISION_CAPS))) events.push(ev)

    // Vision model → captureScreenshot injected as true (model never set it).
    expect(browserInputs).toEqual([{ captureScreenshot: true }])

    // 2nd request body carries the tool_result with a native image block.
    const messages = bodies[1]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const trBlock = messages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result' && b.tool_use_id === 't_s1')!
    expect(trBlock).toBeDefined()
    expect(Array.isArray(trBlock.content)).toBe(true)
    const blocks = trBlock.content as Array<Record<string, unknown>>
    expect(blocks.some((b) => b.type === 'text')).toBe(true)
    const imageBlock = blocks.find((b) => b.type === 'image') as { source: Record<string, unknown> } | undefined
    expect(imageBlock).toBeDefined()
    expect(imageBlock!.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'QUJD' })
  })

  test('non-vision model skips screenshot capture', async () => {
    let call = 0
    globalThis.fetch = (async () => {
      call += 1
      return sseResponse(call === 1 ? anthropicSnapTurn('t_s1') : ANTHROPIC_DONE)
    }) as typeof fetch

    const browserInputs: unknown[] = []
    const bridge: AiBrowserBridge = {
      async callBrowser(_name, input): Promise<AiToolOutput> {
        browserInputs.push(input)
        return { ok: true, data: { layout: { warnings: [] } } }
      },
    }

    for await (const _ of anthropicDriver.stream(makeRequest(bridge, NO_VISION_CAPS))) { void _ }
    expect(browserInputs).toEqual([{ captureScreenshot: false }])
  })

  test('stubs the earlier render_snapshot once a newer one supersedes it', async () => {
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      if (bodies.length === 1) return sseResponse(anthropicSnapTurn('t_s1'))
      if (bodies.length === 2) return sseResponse(anthropicSnapTurn('t_s2'))
      return sseResponse(ANTHROPIC_DONE)
    }) as typeof fetch

    const bridge: AiBrowserBridge = {
      async callBrowser(): Promise<AiToolOutput> {
        return screenshotOutput
      },
    }

    for await (const _ of anthropicDriver.stream(makeRequest(bridge, VISION_CAPS))) { void _ }

    // 3rd POST replays both tool results. The first (t_s1) must be stubbed to a
    // plain string breadcrumb; the latest (t_s2) keeps its native image block.
    const messages = bodies[2]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const allBlocks = messages.flatMap((m) => m.content)
    const first = allBlocks.find((b) => b.tool_use_id === 't_s1')!
    const latest = allBlocks.find((b) => b.tool_use_id === 't_s2')!

    expect(typeof first.content).toBe('string')
    expect(first.content as string).toContain('site_render_snapshot')
    expect(first.content as string).toContain('again')

    expect(Array.isArray(latest.content)).toBe(true)
    expect((latest.content as Array<Record<string, unknown>>).some((b) => b.type === 'image')).toBe(true)
  })
})

describe('text-only providers drop the image with a note (Ollama)', () => {
  const ollamaSnapTurn = JSON.stringify({
    choices: [
      {
        delta: { tool_calls: [{ index: 0, id: 't_s1', function: { name: 'site_render_snapshot', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      },
    ],
  })
  const ollamaDone = JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })

  function ollamaSse(payload: string): string {
    return `data: ${payload}\n\ndata: [DONE]\n\n`
  }

  test('render_snapshot image becomes a text note in the role:tool message', async () => {
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return sseResponse(ollamaSse(bodies.length === 1 ? ollamaSnapTurn : ollamaDone))
    }) as typeof fetch

    const bridge: AiBrowserBridge = {
      async callBrowser(): Promise<AiToolOutput> {
        return screenshotOutput
      },
    }
    const req = makeRequest(bridge, VISION_CAPS, {
      modelId: 'llava',
      credentials: { id: 'cr', providerId: 'ollama', authMode: 'baseUrl', apiKey: null, baseUrl: 'http://localhost:11434' },
    })

    for await (const _ of ollamaDriver.stream(req)) { void _ }

    const secondMessages = bodies[1]!.messages as Array<{ role: string; content: string; tool_call_id?: string }>
    const toolMsg = secondMessages.find((m) => m.role === 'tool')!
    expect(toolMsg).toBeDefined()
    expect(typeof toolMsg.content).toBe('string')
    expect(toolMsg.content).toContain('omitted')
  })
})
