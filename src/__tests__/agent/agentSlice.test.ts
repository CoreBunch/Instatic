import { describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import {
  processStreamEvent,
  executeAgentTool,
  type AgentBridgeRuntime,
  type AgentTextStreamSink,
  type AgentMessage,
  type AgentToolCall,
} from '@site/agent'
import type { ConversationView } from '@admin/ai/api'
import { INTERRUPTED_TOOL_RESULT_ERROR, type AiUserContentBlock } from '@core/ai'
import '@modules/base'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function freshAgentState() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeClassId: null,
    isAgentOpen: true,
    isAgentStreaming: true,
    agentMessages: [],
    agentError: null,
    agentConversationId: null,
    agentActiveCredentialId: null,
    agentActiveModelId: null,
    agentUsage: {
      contextTokens: null,
      contextCredentialId: null,
      contextModelId: null,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    },
    isAgentConversationPending: false,
    isAgentProviderPending: false,
    agentComposerEpoch: 0,
    agentConversations: [],
    hasUnsavedChanges: false,
  })

  const site = useEditorStore.getState().createSite('Agent Test')
  const rootId = site.pages[0].rootNodeId
  const assistantId = 'assistant-1'
  const assistantMessage: AgentMessage = {
    id: assistantId,
    role: 'assistant',
    blocks: [],
    timestamp: Date.now(),
  }
  useEditorStore.setState({ agentMessages: [assistantMessage] })
  return { assistantId, rootId }
}

function emptyBridge(): AgentBridgeRuntime {
  return { bridgeId: null }
}

const noopTextSink: AgentTextStreamSink = {
  append: () => {},
  flush: () => {},
}

function getToolCallBlocks(message: AgentMessage): AgentToolCall[] {
  return message.blocks
    .filter((block): block is { kind: 'toolCall'; toolCall: AgentToolCall } => block.kind === 'toolCall')
    .map((block) => block.toolCall)
}

interface InterceptedFetch {
  url: string
  body: string
  method: string
}

/**
 * URL-routed fetch interceptor. `routes` maps a path prefix or exact match
 * to a response factory. Unmatched URLs return 404 so the test surfaces
 * any unexpected call instead of hanging.
 */
function captureFetchByRoute(
  routes: Record<string, (call: number, init: RequestInit | undefined) => Response | Promise<Response>>,
): { restore: () => void; calls: InterceptedFetch[] } {
  const original = globalThis.fetch
  const calls: InterceptedFetch[] = []
  const perRouteCount: Record<string, number> = {}
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, body: String(init?.body ?? ''), method })
    // Find the most-specific matching route (longest prefix first).
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url === k || url.startsWith(k))
    if (!key) {
      return new Response('Not found', { status: 404 })
    }
    const idx = (perRouteCount[key] ?? 0)
    perRouteCount[key] = idx + 1
    return routes[key]!(idx, init)
  }) as typeof fetch
  return {
    restore() {
      globalThis.fetch = original
    },
    calls,
  }
}

function ndjsonResponse(events: object[]): Response {
  const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}

const defaultsResponse = () =>
  new Response(
    JSON.stringify({ defaults: { site: { credentialId: 'cred-1', modelId: 'claude-sonnet-4-6' } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

const conversationCreateResponse = (id: string) =>
  new Response(
    JSON.stringify({ conversation: { id } }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  )

const conversationDetailMessagesResponse = (
  id: string,
  messages: unknown[],
  selection: { credentialId: string; modelId: string } = {
    credentialId: 'cred-1',
    modelId: 'claude-sonnet-4-6',
  },
) =>
  new Response(JSON.stringify({
    conversation: {
      id,
      scope: 'site',
      title: 'Image',
      credentialId: selection.credentialId,
      modelId: selection.modelId,
      promptTokensTotal: 0,
      completionTokensTotal: 0,
      costUsdTotal: 0,
      cacheReadTokensTotal: 0,
      cacheCreationTokensTotal: 0,
      contextTokens: 0,
      createdAt: '2026-07-11T10:00:00.000Z',
      updatedAt: '2026-07-11T10:00:00.000Z',
      messages,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const conversationDetailResponse = (
  id: string,
  content: unknown[],
  selection?: { credentialId: string; modelId: string },
) => conversationDetailMessagesResponse(id, [{
  id: 'message-image',
  position: 0,
  role: 'user',
  content,
  toolCallId: null,
  toolName: null,
  createdAt: '2026-07-11T10:00:00.000Z',
}], selection)

const toolResultAckResponse = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const textContent = (text: string): AiUserContentBlock[] => [{ kind: 'text', text }]

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

// ---------------------------------------------------------------------------
// processStreamEvent — bridge handshake + tool requests
// ---------------------------------------------------------------------------

describe('processStreamEvent — bridge handshake', () => {
  it('captures the bridgeId on bridgeReady', async () => {
    const { assistantId } = freshAgentState()
    const bridge = emptyBridge()

    await processStreamEvent(
      { type: 'bridgeReady', bridgeId: 'bridge-xyz' },
      assistantId,
      noopTextSink,
      useEditorStore.setState,
      bridge,
      null,
      executeAgentTool,
    )

    expect(bridge.bridgeId).toBe('bridge-xyz')
  })
})

describe('processStreamEvent — context and billing usage', () => {
  it('keeps the current model context separate from cumulative billing totals', async () => {
    const { assistantId } = freshAgentState()
    useEditorStore.setState({
      agentActiveCredentialId: 'cred-1',
      agentActiveModelId: 'model-1',
    })

    await processStreamEvent(
      { type: 'context', contextTokens: 4096 },
      assistantId,
      noopTextSink,
      useEditorStore.setState,
      emptyBridge(),
      null,
      executeAgentTool,
    )
    await processStreamEvent(
      {
        type: 'usage',
        promptTokens: 5000,
        completionTokens: 300,
        cacheReadTokens: 2000,
        cacheCreationTokens: 400,
        costUsd: 0.012345,
      },
      assistantId,
      noopTextSink,
      useEditorStore.setState,
      emptyBridge(),
      null,
      executeAgentTool,
    )
    await processStreamEvent(
      {
        type: 'usage',
        promptTokens: 2000,
        completionTokens: 100,
        costUsd: 0.001,
      },
      assistantId,
      noopTextSink,
      useEditorStore.setState,
      emptyBridge(),
      null,
      executeAgentTool,
    )

    expect(useEditorStore.getState().agentUsage).toEqual({
      contextTokens: 4096,
      contextCredentialId: 'cred-1',
      contextModelId: 'model-1',
      promptTokens: 7000,
      completionTokens: 400,
      cacheReadTokens: 2000,
      cacheCreationTokens: 400,
      costUsd: 0.013345,
    })
  })
})

describe('processStreamEvent — toolRequest dispatches to executor', () => {
  it('runs the tool against the editor store and POSTs the result as AiToolOutput', async () => {
    const { assistantId, rootId } = freshAgentState()
    const bridge: AgentBridgeRuntime = { bridgeId: 'bridge-1' }

    const intercept = captureFetchByRoute({
      '/admin/api/ai/tool-result': toolResultAckResponse,
    })

    try {
      await processStreamEvent(
        {
          type: 'toolRequest',
          requestId: 'req-1',
          toolName: 'site_insert_html',
          input: { parentId: rootId, html: '<p>Hi</p>' },
        },
        assistantId,
        () => {},
        useEditorStore.setState,
        bridge,
        null,
        executeAgentTool,
      )
    } finally {
      intercept.restore()
    }

    expect(intercept.calls).toHaveLength(1)
    expect(intercept.calls[0].url).toBe('/admin/api/ai/tool-result')
    const body = JSON.parse(intercept.calls[0].body) as Record<string, unknown>
    expect(body.bridgeId).toBe('bridge-1')
    expect(body.requestId).toBe('req-1')
    // Canonical bridge shape: { ok, data?, error? }.
    const result = body.result as { ok: boolean }
    expect(result.ok).toBe(true)

    const page = useEditorStore.getState().site!.pages[0]
    expect(Object.values(page.nodes).some((n) => n.moduleId === 'base.text')).toBe(true)
  })

  it('reports an error result when the tool input is invalid', async () => {
    const { assistantId } = freshAgentState()
    const bridge: AgentBridgeRuntime = { bridgeId: 'bridge-2' }

    const intercept = captureFetchByRoute({
      '/admin/api/ai/tool-result': toolResultAckResponse,
    })

    try {
      await processStreamEvent(
        {
          type: 'toolRequest',
          requestId: 'req-2',
          toolName: 'site_insert_html',
          input: { parentId: 'nonexistent-parent', html: '<p>Test</p>' },
        },
        assistantId,
        () => {},
        useEditorStore.setState,
        bridge,
        null,
        executeAgentTool,
      )
    } finally {
      intercept.restore()
    }

    expect(intercept.calls).toHaveLength(1)
    const body = JSON.parse(intercept.calls[0].body) as { result: { ok: boolean; error?: string } }
    expect(body.result.ok).toBe(false)
    expect(body.result.error).toContain('not found')
  })

  it('retains every image returned by a browser tool for the conversation gallery', async () => {
    const { assistantId } = freshAgentState()
    const bridge: AgentBridgeRuntime = { bridgeId: 'bridge-images' }
    const intercept = captureFetchByRoute({
      '/admin/api/ai/tool-result': toolResultAckResponse,
    })

    try {
      await processStreamEvent(
        {
          type: 'toolCall',
          toolCallId: 'tool-images',
          toolName: 'site_render_snapshot',
          input: {},
          status: 'pending',
        },
        assistantId,
        noopTextSink,
        useEditorStore.setState,
        bridge,
        null,
        executeAgentTool,
      )
      await processStreamEvent(
        {
          type: 'toolRequest',
          requestId: 'request-images',
          toolName: 'site_render_snapshot',
          input: {},
        },
        assistantId,
        noopTextSink,
        useEditorStore.setState,
        bridge,
        null,
        async () => ({
          ok: true,
          images: [
            { mimeType: 'image/png', data: 'QUJD' },
            { mimeType: 'image/jpeg', data: 'REVG' },
          ],
        }),
      )
    } finally {
      intercept.restore()
    }

    const message = useEditorStore.getState().agentMessages[0]!
    expect(getToolCallBlocks(message)[0]?.previewImages).toEqual([
      'data:image/png;base64,QUJD',
      'data:image/jpeg;base64,REVG',
    ])
    const posted = JSON.parse(intercept.calls[0]!.body) as {
      result: { images?: Array<{ mimeType: string; data: string }> }
    }
    expect(posted.result.images).toEqual([
      { mimeType: 'image/png', data: 'QUJD' },
      { mimeType: 'image/jpeg', data: 'REVG' },
    ])
  })
})

// ---------------------------------------------------------------------------
// processStreamEvent — toolCall + toolResult rendering for the message thread
// ---------------------------------------------------------------------------

describe('processStreamEvent — toolCall / toolResult badges', () => {
  it('adds a pending tool call on toolCall and flips status on the paired toolResult', async () => {
    const { assistantId } = freshAgentState()
    const bridge = emptyBridge()

    await processStreamEvent(
      {
        type: 'toolCall',
        toolCallId: 'toolu_1',
        toolName: 'site_read_document',
        input: {},
        status: 'pending',
      },
      assistantId,
      noopTextSink,
      useEditorStore.setState,
      bridge,
      null,
      executeAgentTool,
    )

    const pending = getToolCallBlocks(useEditorStore.getState().agentMessages[0])
    expect(pending).toHaveLength(1)
    expect(pending[0].actionType).toBe('site_read_document')
    expect(pending[0].status).toBe('pending')

    await processStreamEvent(
      {
        type: 'toolResult',
        toolCallId: 'toolu_1',
        toolName: 'site_read_document',
        ok: true,
      },
      assistantId,
      noopTextSink,
      useEditorStore.setState,
      bridge,
      null,
      executeAgentTool,
    )

    const completed = getToolCallBlocks(useEditorStore.getState().agentMessages[0])
    expect(completed).toHaveLength(1)
    expect(completed[0].status).toBe('success')
  })
})

describe('processStreamEvent — chronological text/tool ordering', () => {
  it('renders text → tool → text as three blocks in arrival order', async () => {
    const { assistantId } = freshAgentState()
    const bridge = emptyBridge()

    // Simulate a real-world stream: write some text, then run a tool, then
    // write more text. The blocks model preserves order across event types.
    const inlineTextSink: AgentTextStreamSink = {
      append(id, text) {
        useEditorStore.setState((state) => {
          const msg = state.agentMessages.find((m) => m.id === id)
          if (!msg) return
          const last = msg.blocks[msg.blocks.length - 1]
          if (last && last.kind === 'text') {
            last.text += text
          } else {
            msg.blocks.push({ kind: 'text', text })
          }
        })
      },
      flush() {},
    }

    await processStreamEvent(
      { type: 'text', text: 'I will inspect the page first.' },
      assistantId,
      inlineTextSink,
      useEditorStore.setState,
      bridge,
      null,
      executeAgentTool,
    )

    await processStreamEvent(
      {
        type: 'toolCall',
        toolCallId: 'toolu_1',
        toolName: 'site_read_document',
        input: {},
        status: 'pending',
      },
      assistantId,
      inlineTextSink,
      useEditorStore.setState,
      bridge,
      null,
      executeAgentTool,
    )

    await processStreamEvent(
      {
        type: 'toolResult',
        toolCallId: 'toolu_1',
        toolName: 'site_read_document',
        ok: true,
      },
      assistantId,
      inlineTextSink,
      useEditorStore.setState,
      bridge,
      null,
      executeAgentTool,
    )

    await processStreamEvent(
      { type: 'text', text: 'All done — root has 3 children.' },
      assistantId,
      inlineTextSink,
      useEditorStore.setState,
      bridge,
      null,
      executeAgentTool,
    )

    const blocks = useEditorStore.getState().agentMessages[0].blocks
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ kind: 'text', text: 'I will inspect the page first.' })
    expect(blocks[1].kind).toBe('toolCall')
    expect(blocks[2]).toMatchObject({ kind: 'text', text: 'All done — root has 3 children.' })
  })
})

// ---------------------------------------------------------------------------
// sendAgentMessage — request lifecycle
// ---------------------------------------------------------------------------

describe('sendAgentMessage — request lifecycle', () => {
  it('opens defaults + conversation + chat streams on first send', async () => {
    const { rootId } = freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-1'),
      '/admin/api/ai/chat/site': () => ndjsonResponse([
        { type: 'bridgeReady', bridgeId: 'b-1' },
        { type: 'text', text: 'Inserting hero…' },
        { type: 'done' },
      ]),
    })

    let result: { accepted: boolean } | undefined
    try {
      result = await useEditorStore.getState().sendAgentMessage(textContent('Add a hero'))
    } finally {
      intercept.restore()
    }

    // Three calls: GET defaults → POST conversations → POST chat/site.
    const defaultsCalls = intercept.calls.filter((c) => c.url === '/admin/api/ai/defaults')
    const conversationCalls = intercept.calls.filter((c) => c.url === '/admin/api/ai/conversations')
    const chatCalls = intercept.calls.filter((c) => c.url === '/admin/api/ai/chat/site')
    expect(defaultsCalls).toHaveLength(1)
    expect(conversationCalls).toHaveLength(1)
    expect(chatCalls).toHaveLength(1)
    expect(useEditorStore.getState().agentConversationId).toBe('conv-1')
    expect(result).toEqual({ accepted: true })
    expect(JSON.parse(chatCalls[0]!.body)).toMatchObject({
      conversationId: 'conv-1',
      content: [{ kind: 'text', text: 'Add a hero' }],
    })
    void rootId
  })

  it('stops a first send while conversation creation is still pending', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })
    const createStarted = deferred<void>()
    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': (_call, init) => {
        createStarted.resolve()
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const rejectAbort = () => reject(
            signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
          )
          if (signal?.aborted) rejectAbort()
          else signal?.addEventListener('abort', rejectAbort, { once: true })
        })
      },
      '/admin/api/ai/chat/site': () => ndjsonResponse([{ type: 'done' }]),
    })

    try {
      const sending = useEditorStore.getState().sendAgentMessage(textContent('Start'))
      await createStarted.promise
      expect(useEditorStore.getState().isAgentStreaming).toBe(true)
      useEditorStore.getState().abortAgent()

      expect(await sending).toEqual({ accepted: false })
      expect(useEditorStore.getState().isAgentStreaming).toBe(false)
      expect(useEditorStore.getState().agentConversationId).toBeNull()
      expect(useEditorStore.getState().agentMessages).toEqual([])
      expect(intercept.calls.some((call) => call.url === '/admin/api/ai/chat/site')).toBe(false)
    } finally {
      intercept.restore()
    }
  })

  it('sends and renders an image-only user turn without inventing placeholder text', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })
    const image = {
      kind: 'image' as const,
      mimeType: 'image/jpeg' as const,
      data: 'QUJD',
    }

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-image'),
      '/admin/api/ai/chat/site': () => ndjsonResponse([
        { type: 'bridgeReady', bridgeId: 'b-image' },
        { type: 'done' },
      ]),
    })

    let result: { accepted: boolean } | undefined
    try {
      result = await useEditorStore.getState().sendAgentMessage([image])
    } finally {
      intercept.restore()
    }

    expect(result).toEqual({ accepted: true })
    const chat = intercept.calls.find((call) => call.url === '/admin/api/ai/chat/site')
    expect(chat).toBeDefined()
    expect(JSON.parse(chat!.body)).toMatchObject({
      conversationId: 'conv-image',
      content: [image],
    })
    const userMessage = useEditorStore.getState().agentMessages.find((message) => message.role === 'user')
    expect(userMessage?.blocks).toEqual([{
      kind: 'image',
      mimeType: 'image/jpeg',
      src: 'data:image/jpeg;base64,QUJD',
    }])
  })

  it('reuses the same conversation id on follow-up sends', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentMessages: [],
      agentConversationId: null,
    })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-99'),
      '/admin/api/ai/chat/site': () => ndjsonResponse([
        { type: 'bridgeReady', bridgeId: 'b-1' },
        { type: 'done' },
      ]),
    })

    try {
      await useEditorStore.getState().sendAgentMessage(textContent('First message.'))
      await useEditorStore.getState().sendAgentMessage(textContent('Follow-up.'))
    } finally {
      intercept.restore()
    }

    // Conversation is created ONCE; subsequent messages reuse the id.
    expect(intercept.calls.filter((c) => c.url === '/admin/api/ai/conversations')).toHaveLength(1)
    // Defaults fetched ONCE — second send already has a conversation.
    expect(intercept.calls.filter((c) => c.url === '/admin/api/ai/defaults')).toHaveLength(1)
    // Chat hit twice.
    const chatCalls = intercept.calls.filter((c) => c.url === '/admin/api/ai/chat/site')
    expect(chatCalls).toHaveLength(2)
    for (const call of chatCalls) {
      const body = JSON.parse(call.body) as { conversationId: string }
      expect(body.conversationId).toBe('conv-99')
    }
  })

  it('runs a toolRequest from the stream and POSTs the result to /admin/api/ai/tool-result', async () => {
    const { rootId } = freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-7'),
      '/admin/api/ai/chat/site': () => ndjsonResponse([
        { type: 'bridgeReady', bridgeId: 'b-3' },
        {
          type: 'toolRequest',
          requestId: 'req-7',
          toolName: 'site_apply_css',
          input: { operation: 'merge', css: '.pricing-card { padding: 24px; }' },
        },
        { type: 'done' },
      ]),
      '/admin/api/ai/tool-result': toolResultAckResponse,
    })

    try {
      await useEditorStore.getState().sendAgentMessage(textContent('Create a pricing card class.'))
    } finally {
      intercept.restore()
    }

    const toolResultCalls = intercept.calls.filter((c) => c.url === '/admin/api/ai/tool-result')
    expect(toolResultCalls).toHaveLength(1)
    const body = JSON.parse(toolResultCalls[0].body) as {
      bridgeId: string
      requestId: string
      result: { ok: boolean; data?: { cssRulesCreated?: number } }
    }
    expect(body.bridgeId).toBe('b-3')
    expect(body.requestId).toBe('req-7')
    expect(body.result.ok).toBe(true)
    expect(body.result.data?.cssRulesCreated).toBe(1)

    const classes = useEditorStore.getState().site!.styleRules
    expect(Object.values(classes).some((c) => c.name === 'pricing-card')).toBe(true)
    void rootId
  })

  it('aborts the active send and surfaces an active tool-result POST failure', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })
    let toolResultSignal: AbortSignal | null = null

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-tool-result-failure'),
      '/admin/api/ai/chat/site': () => ndjsonResponse([
        { type: 'bridgeReady', bridgeId: 'bridge-tool-result-failure' },
        {
          type: 'toolCall',
          toolCallId: 'call-tool-result-failure',
          toolName: 'site_apply_css',
          input: { css: '.failure-test { display: block; }' },
          status: 'pending',
        },
        {
          type: 'toolRequest',
          requestId: 'request-tool-result-failure',
          toolName: 'site_apply_css',
          input: { css: '.failure-test { display: block; }' },
        },
        { type: 'done' },
      ]),
      '/admin/api/ai/tool-result': (_call, init) => {
        toolResultSignal = init?.signal ?? null
        return new Response(
          JSON.stringify({ error: 'The active tool bridge no longer exists.' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })

    let result: { accepted: boolean }
    try {
      result = await useEditorStore.getState().sendAgentMessage(
        textContent('Apply a class, then continue.'),
      )
    } finally {
      intercept.restore()
    }

    expect(result).toEqual({ accepted: true })
    expect(toolResultSignal).not.toBeNull()
    expect(toolResultSignal!.aborted).toBe(true)
    expect(useEditorStore.getState().isAgentStreaming).toBe(false)
    expect(useEditorStore.getState().agentError).toContain(
      'The active tool bridge no longer exists.',
    )
    const calls = useEditorStore.getState().agentMessages.flatMap(getToolCallBlocks)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      status: 'error',
      result: { ok: false, error: expect.stringContaining('The active tool bridge no longer exists.') },
    })
  })

  it('does not mistake an active tool-result AbortError for an intentional Stop', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })
    let toolResultSignal: AbortSignal | null = null

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-active-abort'),
      '/admin/api/ai/chat/site': () => ndjsonResponse([
        { type: 'bridgeReady', bridgeId: 'bridge-active-abort' },
        {
          type: 'toolRequest',
          requestId: 'request-active-abort',
          toolName: 'site_apply_css',
          input: { css: '.active-abort { display: block; }' },
        },
        { type: 'done' },
      ]),
      '/admin/api/ai/tool-result': (_call, init) => {
        toolResultSignal = init?.signal ?? null
        const error = new Error('Tool-result delivery was aborted upstream.')
        error.name = 'AbortError'
        return Promise.reject(error)
      },
    })

    try {
      expect(await useEditorStore.getState().sendAgentMessage(
        textContent('Apply a class, then continue.'),
      )).toEqual({ accepted: true })
    } finally {
      intercept.restore()
    }

    expect(toolResultSignal).not.toBeNull()
    expect(toolResultSignal!.aborted).toBe(true)
    expect(useEditorStore.getState().isAgentStreaming).toBe(false)
    expect(useEditorStore.getState().agentError).toContain(
      'Tool-result delivery was aborted upstream.',
    )
  })

  it('surfaces a clear error when no site default credential is configured', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })

    const intercept = captureFetchByRoute({
      // Empty defaults — no site default configured.
      '/admin/api/ai/defaults': () => new Response(
        JSON.stringify({ defaults: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    })

    try {
      await useEditorStore.getState().sendAgentMessage(textContent('Anything.'))
    } finally {
      intercept.restore()
    }

    expect(useEditorStore.getState().agentError).toContain('No AI provider configured')
    // Should NOT have reached the chat endpoint.
    expect(intercept.calls.some((c) => c.url === '/admin/api/ai/chat/site')).toBe(false)
  })
})

describe('loadAgentConversation — rehydration', () => {
  it('restores persisted user image blocks and advances the composer epoch', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })
    const image = {
      kind: 'image',
      mimeType: 'image/jpeg',
      url: '/admin/api/ai/conversations/conv-image/messages/message-image/images/0',
    }
    const intercept = captureFetchByRoute({
      '/admin/api/ai/conversations/conv-image': () =>
        conversationDetailResponse('conv-image', [image]),
    })

    try {
      await useEditorStore.getState().loadAgentConversation('conv-image')
    } finally {
      intercept.restore()
    }

    const state = useEditorStore.getState()
    expect(state.agentConversationId).toBe('conv-image')
    expect(state.agentComposerEpoch).toBe(1)
    expect(state.agentMessages).toHaveLength(1)
    expect(state.agentMessages[0]?.blocks).toEqual([{
      kind: 'image',
      mimeType: 'image/jpeg',
      src: image.url,
    }])
  })

  it('blocks Send until an in-flight conversation load commits', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: 'conv-old',
      agentActiveCredentialId: 'cred-old',
      agentActiveModelId: 'model-old',
      agentMessages: [],
    })
    const loadStarted = deferred<void>()
    const loadResponse = deferred<Response>()
    const intercept = captureFetchByRoute({
      '/admin/api/ai/conversations/conv-new': () => {
        loadStarted.resolve()
        return loadResponse.promise
      },
      '/admin/api/ai/chat/site': () => ndjsonResponse([{ type: 'done' }]),
    })

    try {
      const loading = useEditorStore.getState().loadAgentConversation('conv-new')
      await loadStarted.promise
      expect(useEditorStore.getState().isAgentConversationPending).toBe(true)
      expect(await useEditorStore.getState().sendAgentMessage(textContent('Wait')))
        .toEqual({ accepted: false })
      expect(intercept.calls.some((call) => call.url === '/admin/api/ai/chat/site')).toBe(false)

      loadResponse.resolve(conversationDetailResponse('conv-new', [
        { kind: 'text', text: 'Loaded' },
      ]))
      await loading
      expect(useEditorStore.getState().agentConversationId).toBe('conv-new')
      expect(useEditorStore.getState().isAgentConversationPending).toBe(false)
    } finally {
      intercept.restore()
    }
  })

  it('restores an interrupted screenshot as a failed historical call, never live work', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentMessages: [],
      agentError: 'stale error',
    })
    const intercept = captureFetchByRoute({
      '/admin/api/ai/conversations/conv-restart': () =>
        conversationDetailMessagesResponse('conv-restart', [
          {
            id: 'prompt-1',
            position: 0,
            role: 'user',
            content: [{ kind: 'text', text: 'Capture desktop.' }],
            toolCallId: null,
            toolName: null,
            createdAt: '2026-07-11T10:00:00.000Z',
          },
          {
            id: 'snapshot-call',
            position: 1,
            role: 'assistant',
            content: [{
              kind: 'toolCall',
              toolCallId: 'snapshot-interrupted',
              toolName: 'site_render_snapshot',
              input: { breakpointId: 'desktop' },
            }],
            toolCallId: 'snapshot-interrupted',
            toolName: 'site_render_snapshot',
            createdAt: '2026-07-11T10:00:01.000Z',
          },
        ]),
    })

    try {
      await useEditorStore.getState().loadAgentConversation('conv-restart')
    } finally {
      intercept.restore()
    }

    const state = useEditorStore.getState()
    const restoredCalls = state.agentMessages.flatMap(getToolCallBlocks)
    expect(restoredCalls).toHaveLength(1)
    expect(restoredCalls[0]).toMatchObject({
      externalId: 'snapshot-interrupted',
      actionType: 'site_render_snapshot',
      params: { breakpointId: 'desktop' },
      status: 'error',
      result: { ok: false, error: INTERRUPTED_TOOL_RESULT_ERROR },
    })
    expect(restoredCalls[0]?.previewImages).toBeUndefined()
    expect(state.agentError).toBeNull()
    expect(state.isAgentStreaming).toBe(false)
    expect(state.isAgentConversationPending).toBe(false)
    expect(state.agentConversationId).toBe('conv-restart')
  })
})

describe('conversation reset key-set', () => {
  // All three reset paths clear the same conversation keys and advance the
  // composer epoch so local text/image drafts cannot cross conversations.
  const RESET_SNAPSHOT = {
    agentMessages: [],
    agentError: null,
    agentConversationId: null,
    agentActiveCredentialId: null,
    agentActiveModelId: null,
    agentUsage: {
      contextTokens: null,
      contextCredentialId: null,
      contextModelId: null,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    },
    agentComposerEpoch: 1,
  }

  function seedDirtyConversation() {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentMessages: [{ id: 'm1', role: 'user', blocks: [{ kind: 'text', text: 'hi' }], timestamp: 1 }],
      agentError: 'AI server is not running. Start it with: bun run dev',
      agentConversationId: 'conv-dirty',
      agentActiveCredentialId: 'cred-1',
      agentActiveModelId: 'model-1',
      agentUsage: {
        contextTokens: 4096,
        contextCredentialId: 'cred-1',
        contextModelId: 'model-1',
        promptTokens: 12_000,
        completionTokens: 800,
        cacheReadTokens: 4_000,
        cacheCreationTokens: 500,
        costUsd: 0.42,
      },
    })
  }

  function pickResetKeys() {
    const s = useEditorStore.getState()
    return {
      agentMessages: s.agentMessages,
      agentError: s.agentError,
      agentConversationId: s.agentConversationId,
      agentActiveCredentialId: s.agentActiveCredentialId,
      agentActiveModelId: s.agentActiveModelId,
      agentUsage: s.agentUsage,
      agentComposerEpoch: s.agentComposerEpoch,
    }
  }

  it('startNewAgentConversation resets conversation state and remounts the composer', () => {
    seedDirtyConversation()
    useEditorStore.getState().startNewAgentConversation()
    expect(pickResetKeys()).toEqual(RESET_SNAPSHOT)
  })

  it('startNewAgentConversation matches clearAgentMessages exactly', () => {
    seedDirtyConversation()
    useEditorStore.getState().clearAgentMessages()
    const afterClear = pickResetKeys()

    seedDirtyConversation()
    useEditorStore.getState().startNewAgentConversation()
    const afterNew = pickResetKeys()

    expect(afterNew).toEqual(afterClear)
  })

  it('deleteAgentConversation clears a stuck error banner on the active conversation', async () => {
    seedDirtyConversation()
    useEditorStore.setState({
      agentConversations: [{ id: 'conv-dirty' } as ConversationView],
    })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/conversations/conv-dirty': () =>
        new Response(null, { status: 204 }),
    })

    try {
      await useEditorStore.getState().deleteAgentConversation('conv-dirty')
    } finally {
      intercept.restore()
    }

    // The whole reset key-set — agentError included — is cleared, so no stale
    // 502/error banner survives the delete.
    expect(pickResetKeys()).toEqual(RESET_SNAPSHOT)
    expect(useEditorStore.getState().agentConversations).toHaveLength(0)
  })
})

describe('sendAgentMessage — streaming + error surfacing', () => {
  it('treats a clean EOF without done/error as an interrupted turn', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-truncated'),
      '/admin/api/ai/chat/site': () => ndjsonResponse([
        { type: 'bridgeReady', bridgeId: 'b-truncated' },
        {
          type: 'toolCall',
          toolCallId: 'snapshot-truncated',
          toolName: 'site_render_snapshot',
          input: { breakpointId: 'desktop' },
          status: 'pending',
        },
      ]),
    })

    try {
      expect(await useEditorStore.getState().sendAgentMessage(textContent('Inspect it.'))).toEqual({
        accepted: true,
      })
    } finally {
      intercept.restore()
    }

    const state = useEditorStore.getState()
    expect(state.agentError).toContain('server may have restarted')
    expect(state.isAgentStreaming).toBe(false)
    expect(state.agentMessages.flatMap(getToolCallBlocks)[0]).toMatchObject({
      status: 'error',
      result: { ok: false, error: expect.stringContaining('server may have restarted') },
    })
  })

  it('dispatches streamed events and surfaces a mid-stream error event once', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-mid'),
      '/admin/api/ai/chat/site': () => ndjsonResponse([
        { type: 'bridgeReady', bridgeId: 'b-1' },
        { type: 'text', text: 'Working…' },
        { type: 'error', message: 'Provider rate limit exceeded.' },
        { type: 'done' },
      ]),
    })

    try {
      await useEditorStore.getState().sendAgentMessage(textContent('Go'))
    } finally {
      intercept.restore()
    }

    // Text event dispatched into the assistant message.
    const assistant = useEditorStore.getState().agentMessages.find((m) => m.role === 'assistant')!
    expect(assistant.blocks.some((b) => b.kind === 'text' && b.text.includes('Working…'))).toBe(true)
    // The error event's message is surfaced verbatim (once).
    expect(useEditorStore.getState().agentError).toBe('Provider rate limit exceeded.')
    // Streaming flag resolved cleanly in the finally block.
    expect(useEditorStore.getState().isAgentStreaming).toBe(false)
  })

  it('rejects a non-ok chat response without adding an optimistic turn', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-err'),
      '/admin/api/ai/chat/site': () => new Response('boom', { status: 500 }),
    })

    let result: { accepted: boolean } | undefined
    try {
      result = await useEditorStore.getState().sendAgentMessage(textContent('Do a thing'))
    } finally {
      intercept.restore()
    }

    expect(result).toEqual({ accepted: false })
    expect(useEditorStore.getState().agentError).toBe('boom')
    expect(useEditorStore.getState().agentMessages).toEqual([])
    expect(useEditorStore.getState().isAgentStreaming).toBe(false)
  })

  it('reuses the loadScopeDefault-staged credential on send without re-fetching defaults', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentMessages: [],
      agentConversationId: null,
      agentActiveCredentialId: null,
      agentActiveModelId: null,
    })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-staged'),
      '/admin/api/ai/chat/site': () => ndjsonResponse([
        { type: 'bridgeReady', bridgeId: 'b-1' },
        { type: 'done' },
      ]),
    })

    try {
      // Panel-open path stages the default…
      await useEditorStore.getState().loadScopeDefault()
      // …first send must reuse it, NOT fetch the default a second time.
      await useEditorStore.getState().sendAgentMessage(textContent('Hi'))
    } finally {
      intercept.restore()
    }

    expect(intercept.calls.filter((c) => c.url === '/admin/api/ai/defaults')).toHaveLength(1)
    const convCalls = intercept.calls.filter((c) => c.url === '/admin/api/ai/conversations')
    expect(convCalls).toHaveLength(1)
    const body = JSON.parse(convCalls[0].body) as { credentialId: string; modelId: string }
    expect(body.credentialId).toBe('cred-1')
    expect(body.modelId).toBe('claude-sonnet-4-6')
  })
})

// ---------------------------------------------------------------------------
// loadScopeDefault — preload the configured default into the picker
// ---------------------------------------------------------------------------

describe('loadScopeDefault', () => {
  it('stages the scope default as the active selection and clears any error', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: null,
      agentActiveCredentialId: null,
      agentActiveModelId: null,
      agentError: 'No AI provider configured for the site editor.',
    })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
    })

    try {
      await useEditorStore.getState().loadScopeDefault()
    } finally {
      intercept.restore()
    }

    expect(useEditorStore.getState().agentActiveCredentialId).toBe('cred-1')
    expect(useEditorStore.getState().agentActiveModelId).toBe('claude-sonnet-4-6')
    expect(useEditorStore.getState().agentError).toBeNull()
  })

  it('does not clobber an explicit selection that is already staged', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: null,
      agentActiveCredentialId: 'cred-picked',
      agentActiveModelId: 'model-picked',
      agentError: null,
    })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
    })

    try {
      await useEditorStore.getState().loadScopeDefault()
    } finally {
      intercept.restore()
    }

    // No defaults fetch, selection untouched.
    expect(intercept.calls.some((c) => c.url === '/admin/api/ai/defaults')).toBe(false)
    expect(useEditorStore.getState().agentActiveCredentialId).toBe('cred-picked')
    expect(useEditorStore.getState().agentActiveModelId).toBe('model-picked')
  })

  it('leaves the selection empty when no default is configured', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: null,
      agentActiveCredentialId: null,
      agentActiveModelId: null,
    })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': () => new Response(
        JSON.stringify({ defaults: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    })

    try {
      await useEditorStore.getState().loadScopeDefault()
    } finally {
      intercept.restore()
    }

    expect(useEditorStore.getState().agentActiveCredentialId).toBeNull()
    expect(useEditorStore.getState().agentActiveModelId).toBeNull()
  })

  it('does not overwrite a model picked while the default request is in flight', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: null,
      agentActiveCredentialId: null,
      agentActiveModelId: null,
    })
    const requestStarted = deferred<void>()
    const response = deferred<Response>()
    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': () => {
        requestStarted.resolve()
        return response.promise
      },
    })

    try {
      const loading = useEditorStore.getState().loadScopeDefault()
      await requestStarted.promise
      await useEditorStore.getState().setAgentProvider('cred-picked', 'model-picked')
      response.resolve(defaultsResponse())
      await loading
    } finally {
      intercept.restore()
    }

    expect(useEditorStore.getState().agentActiveCredentialId).toBe('cred-picked')
    expect(useEditorStore.getState().agentActiveModelId).toBe('model-picked')
  })
})

// ---------------------------------------------------------------------------
// setAgentProvider — picking a model clears the sticky no-provider error
// ---------------------------------------------------------------------------

describe('setAgentProvider', () => {
  it('clears a sticky no-provider error so the composer re-enables', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: null,
      agentActiveCredentialId: null,
      agentActiveModelId: null,
      agentError: 'No AI provider configured for the site editor.',
    })

    await useEditorStore.getState().setAgentProvider('cred-9', 'model-9')

    expect(useEditorStore.getState().agentActiveCredentialId).toBe('cred-9')
    expect(useEditorStore.getState().agentActiveModelId).toBe('model-9')
    expect(useEditorStore.getState().agentError).toBeNull()
  })

  it('blocks Send until an existing conversation model update finishes', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: 'conv-switch',
      agentActiveCredentialId: 'cred-old',
      agentActiveModelId: 'model-old',
      agentMessages: [],
    })

    const updateStarted = deferred<void>()
    const updateResponse = deferred<Response>()
    const intercept = captureFetchByRoute({
      '/admin/api/ai/conversations/conv-switch': (_call, init) => {
        expect(init?.method).toBe('PUT')
        updateStarted.resolve()
        return updateResponse.promise
      },
      '/admin/api/ai/chat/site': () => ndjsonResponse([{ type: 'done' }]),
    })

    try {
      const changingModel = useEditorStore.getState().setAgentProvider('cred-new', 'model-new')
      await updateStarted.promise
      expect(useEditorStore.getState().isAgentProviderPending).toBe(true)
      expect(await useEditorStore.getState().sendAgentMessage(textContent('Use the new model')))
        .toEqual({ accepted: false })
      expect(intercept.calls.some((call) => call.url === '/admin/api/ai/chat/site')).toBe(false)

      updateResponse.resolve(new Response(JSON.stringify({
        conversation: {
          id: 'conv-switch',
          scope: 'site',
          title: 'Conversation',
          credentialId: 'cred-new',
          modelId: 'model-new',
          promptTokensTotal: 0,
          completionTokensTotal: 0,
          costUsdTotal: 0,
          cacheReadTokensTotal: 0,
          cacheCreationTokensTotal: 0,
          contextTokens: 0,
          createdAt: '2026-07-11T10:00:00.000Z',
          updatedAt: '2026-07-11T10:00:00.000Z',
        },
      }), { headers: { 'content-type': 'application/json' } }))

      await changingModel
      expect(useEditorStore.getState().isAgentProviderPending).toBe(false)
      expect(await useEditorStore.getState().sendAgentMessage(textContent('Use the new model')))
        .toEqual({ accepted: true })
      expect(intercept.calls.map((call) => call.url)).toEqual([
        '/admin/api/ai/conversations/conv-switch',
        '/admin/api/ai/chat/site',
      ])
    } finally {
      intercept.restore()
    }
  })

  it('does not send when the model update it was waiting for fails', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: 'conv-fail',
      agentActiveCredentialId: 'cred-old',
      agentActiveModelId: 'model-old',
      agentMessages: [],
    })

    const updateStarted = deferred<void>()
    const updateResponse = deferred<Response>()
    const intercept = captureFetchByRoute({
      '/admin/api/ai/conversations/conv-fail': (_call, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
          return conversationDetailResponse('conv-fail', [], {
            credentialId: 'cred-old',
            modelId: 'model-old',
          })
        }
        updateStarted.resolve()
        return updateResponse.promise
      },
      '/admin/api/ai/chat/site': () => ndjsonResponse([{ type: 'done' }]),
    })

    try {
      const changingModel = useEditorStore.getState().setAgentProvider('cred-new', 'model-new')
      await updateStarted.promise
      const sending = useEditorStore.getState().sendAgentMessage(textContent('Do not misroute me'))
      updateResponse.resolve(new Response(JSON.stringify({ error: 'update failed' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))

      const [, result] = await Promise.all([changingModel, sending])
      expect(result).toEqual({ accepted: false })
      expect(intercept.calls.some((call) => call.url === '/admin/api/ai/chat/site')).toBe(false)
      expect(useEditorStore.getState().agentActiveCredentialId).toBe('cred-old')
      expect(useEditorStore.getState().agentActiveModelId).toBe('model-old')
    } finally {
      intercept.restore()
    }
  })

  it('reconciles an update whose response was lost after the server committed it', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: 'conv-committed',
      agentActiveCredentialId: 'cred-old',
      agentActiveModelId: 'model-old',
      agentMessages: [],
    })
    const intercept = captureFetchByRoute({
      '/admin/api/ai/conversations/conv-committed': (_call, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
          return conversationDetailResponse('conv-committed', [], {
            credentialId: 'cred-new',
            modelId: 'model-new',
          })
        }
        return Promise.reject(new TypeError('Connection reset after commit'))
      },
      '/admin/api/ai/chat/site': () => ndjsonResponse([{ type: 'done' }]),
    })

    try {
      await useEditorStore.getState().setAgentProvider('cred-new', 'model-new')

      const state = useEditorStore.getState()
      expect(state.agentActiveCredentialId).toBe('cred-new')
      expect(state.agentActiveModelId).toBe('model-new')
      expect(state.agentError).toBeNull()
      expect(state.isAgentProviderPending).toBe(false)
      expect(await state.sendAgentMessage(textContent('Use the committed model')))
        .toEqual({ accepted: true })
      expect(intercept.calls.map((call) => call.method)).toEqual(['PUT', 'GET', 'POST'])
    } finally {
      intercept.restore()
    }
  })

  it('keeps Send locked when an ambiguous update can still commit after reconciliation', async () => {
    freshAgentState()
    useEditorStore.setState({
      isAgentStreaming: false,
      agentConversationId: 'conv-ambiguous',
      agentActiveCredentialId: 'cred-old',
      agentActiveModelId: 'model-old',
      agentMessages: [],
    })
    let serverSelection = { credentialId: 'cred-old', modelId: 'model-old' }
    const intercept = captureFetchByRoute({
      '/admin/api/ai/conversations/conv-ambiguous': (_call, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
          return conversationDetailResponse('conv-ambiguous', [], serverSelection)
        }
        return new Response(JSON.stringify({ error: 'Upstream response was lost' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      },
      '/admin/api/ai/chat/site': () => ndjsonResponse([{ type: 'done' }]),
    })

    try {
      await useEditorStore.getState().setAgentProvider('cred-new', 'model-new')
      // The disconnected PUT commits after the first reconciliation read.
      serverSelection = { credentialId: 'cred-new', modelId: 'model-new' }

      const state = useEditorStore.getState()
      expect(state.agentActiveCredentialId).toBeNull()
      expect(state.agentActiveModelId).toBeNull()
      expect(state.agentError).toContain('server state could not be confirmed')
      expect(await state.sendAgentMessage(textContent('Never route against stale state')))
        .toEqual({ accepted: false })
      expect(intercept.calls.some((call) => call.url === '/admin/api/ai/chat/site')).toBe(false)
    } finally {
      intercept.restore()
    }
  })
})
