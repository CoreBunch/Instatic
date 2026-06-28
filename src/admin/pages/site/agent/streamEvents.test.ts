import { describe, it, expect } from 'bun:test'
import { processStreamEvent } from './streamEvents'
import type { AgentStreamSink, AgentBridgeRuntime } from './types'
import type { EditorStoreSet } from './agentSliceTypes'

// The reasoning case touches only the sink — `set`, the bridge, signal, and the
// tool dispatcher are never reached, so they're inert stubs here.
const noopSet = ((): void => undefined) as EditorStoreSet
const bridge: AgentBridgeRuntime = { bridgeId: null }
const dispatchUnused = async (): Promise<never> => {
  throw new Error('dispatchTool must not be called for a reasoning event')
}

describe('processStreamEvent — reasoning routing', () => {
  it('routes a reasoning delta to appendReasoning and never to the text path', async () => {
    const calls: string[] = []
    const sink: AgentStreamSink = {
      append: (_id, t) => calls.push(`text:${t}`),
      appendReasoning: (id, t) => calls.push(`reasoning:${id}:${t}`),
      flush: () => calls.push('flush'),
    }

    await processStreamEvent(
      { type: 'reasoning', text: 'let me think…' },
      'assistant-1',
      sink,
      noopSet,
      bridge,
      null,
      dispatchUnused,
    )

    // Reasoning goes only to the reasoning buffer — no text append, no flush.
    expect(calls).toEqual(['reasoning:assistant-1:let me think…'])
  })

  it('a text delta still routes to the text path (regression guard)', async () => {
    const calls: string[] = []
    const sink: AgentStreamSink = {
      append: (id, t) => calls.push(`text:${id}:${t}`),
      appendReasoning: (_id, t) => calls.push(`reasoning:${t}`),
      flush: () => calls.push('flush'),
    }

    await processStreamEvent(
      { type: 'text', text: 'hello' },
      'assistant-1',
      sink,
      noopSet,
      bridge,
      null,
      dispatchUnused,
    )

    expect(calls).toEqual(['text:assistant-1:hello'])
  })
})
