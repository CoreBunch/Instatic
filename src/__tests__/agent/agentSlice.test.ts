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
    agentContextTokens: null,
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
  routes: Record<string, (call: number, init: RequestInit | undefined) => Response>,
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

const toolResultAckResponse = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

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

    try {
      await useEditorStore.getState().sendAgentMessage('Add a hero')
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
    void rootId
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
      await useEditorStore.getState().sendAgentMessage('First message.')
      await useEditorStore.getState().sendAgentMessage('Follow-up.')
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
          input: { css: '.pricing-card { padding: 24px; }' },
        },
        { type: 'done' },
      ]),
      '/admin/api/ai/tool-result': toolResultAckResponse,
    })

    try {
      await useEditorStore.getState().sendAgentMessage('Create a pricing card class.')
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
      await useEditorStore.getState().sendAgentMessage('Anything.')
    } finally {
      intercept.restore()
    }

    expect(useEditorStore.getState().agentError).toContain('No AI provider configured')
    // Should NOT have reached the chat endpoint.
    expect(intercept.calls.some((c) => c.url === '/admin/api/ai/chat/site')).toBe(false)
  })
})

describe('conversation reset key-set', () => {
  // All three reset paths must clear the SAME six keys — agentContextTokens and
  // agentError have each silently drifted out of one copy in the past.
  const RESET_SNAPSHOT = {
    agentMessages: [],
    agentError: null,
    agentConversationId: null,
    agentActiveCredentialId: null,
    agentActiveModelId: null,
    agentContextTokens: null,
  }

  function seedDirtyConversation() {
    freshAgentState()
    useEditorStore.setState({
      agentMessages: [{ id: 'm1', role: 'user', blocks: [{ kind: 'text', text: 'hi' }], timestamp: 1 }],
      agentError: 'AI server is not running. Start it with: bun run dev',
      agentConversationId: 'conv-dirty',
      agentActiveCredentialId: 'cred-1',
      agentActiveModelId: 'model-1',
      agentContextTokens: 4096,
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
      agentContextTokens: s.agentContextTokens,
    }
  }

  it('startNewAgentConversation resets the full six-key set (incl. agentContextTokens)', () => {
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
      await useEditorStore.getState().sendAgentMessage('Go')
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

  it('surfaces a non-ok chat response once — single agentError + single placeholder block', async () => {
    freshAgentState()
    useEditorStore.setState({ isAgentStreaming: false, agentMessages: [] })

    const intercept = captureFetchByRoute({
      '/admin/api/ai/defaults': defaultsResponse,
      '/admin/api/ai/conversations': () => conversationCreateResponse('conv-err'),
      '/admin/api/ai/chat/site': () => new Response('boom', { status: 500 }),
    })

    try {
      await useEditorStore.getState().sendAgentMessage('Do a thing')
    } finally {
      intercept.restore()
    }

    expect(useEditorStore.getState().agentError).toContain('Agent request failed')
    const assistant = useEditorStore.getState().agentMessages.find((m) => m.role === 'assistant')!
    // Collapsed double-set (F10): exactly one placeholder block, not two renders.
    expect(assistant.blocks).toHaveLength(1)
    expect(assistant.blocks[0]).toMatchObject({ kind: 'text', text: '_(agent error)_' })
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
      await useEditorStore.getState().sendAgentMessage('Hi')
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
})
