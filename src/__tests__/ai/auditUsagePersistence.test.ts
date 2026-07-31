import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { AiProvider, AiStreamRequest } from '../../../server/ai/drivers/types'
import type { AiStreamEvent } from '../../../server/ai/runtime/types'
import { createConversationsPersister, runChat } from '../../../server/ai/runtime'
import {
  getUsageByModel,
  getUsageByScope,
  getUsageTotals,
} from '../../../server/ai/audit/store'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const fakeTextOnlyDriver: AiProvider = {
  id: 'ollama',
  label: 'Fake Ollama',
  supportedAuthModes: ['baseUrl'],
  capabilities() {
    return {
      toolCalling: false,
      visionInput: false,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    }
  },
  async listModels() {
    return []
  },
  async *stream(): AsyncIterable<AiStreamEvent> {
    yield { type: 'text', text: 'Audit usage reply.' }
    yield { type: 'context', promptTokens: 123 }
    yield { type: 'usage', promptTokens: 123, completionTokens: 45 }
  },
}

describe('AI audit usage persistence', () => {
  let harness: CapabilityTestHarness
  let originalFetch: typeof globalThis.fetch
  let originalError: typeof console.error

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    originalError = console.error
    harness = await createCapabilityTestHarness()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    console.error = originalError
    await harness.cleanup()
  })

  it('rolls up usage from a text-only streamed assistant reply', async () => {
    const cookie = await harness.setupOwner()
    console.error = () => {}
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url === 'http://127.0.0.1:1/api/tags') {
        return Response.json({ models: [{ name: 'e2e-model' }] })
      }
      return originalFetch(input)
    }

    const credentialRes = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'ollama',
        authMode: 'baseUrl',
        displayLabel: 'Local usage fixture',
        baseUrl: 'http://127.0.0.1:1',
      },
    })
    expect(credentialRes.status).toBe(201)
    const { credential } = await readJson<{ credential: { id: string } }>(credentialRes)

    const conversationRes = await harness.ai('/admin/api/ai/conversations', {
      method: 'POST',
      cookie,
      json: {
        scope: 'site',
        title: 'Usage fixture',
        credentialId: credential.id,
        modelId: 'e2e-model',
      },
    })
    expect(conversationRes.status).toBe(201)
    const { conversation } = await readJson<{ conversation: { id: string } }>(conversationRes)

    const persister = createConversationsPersister(harness.db, conversation.id, {
      providerId: 'ollama',
      modelId: 'e2e-model',
    })
    const emitted: AiStreamEvent[] = []

    await runChat({
      driver: fakeTextOnlyDriver,
      request: {
        systemPrompt: [],
        messages: [],
        tools: [],
        modelId: 'e2e-model',
        modelCapabilities: fakeTextOnlyDriver.capabilities('e2e-model'),
        credentials: {
          id: credential.id,
          providerId: 'ollama',
          authMode: 'baseUrl',
          apiKey: null,
          baseUrl: 'http://127.0.0.1:1',
        },
        signal: new AbortController().signal,
        bridge: {
          async callBrowser() {
            return { ok: false, error: 'No browser bridge in this test.' }
          },
        },
        toolContextBase: {
          db: harness.db,
          userId: 'unused',
          capabilities: [],
          scope: 'site',
          conversationId: conversation.id,
          snapshot: null,
        },
      } satisfies AiStreamRequest,
      persister,
      emit(event) {
        emitted.push(event)
      },
    })

    expect(emitted.map((event) => event.type)).toEqual([
      'text',
      'context',
      'usage',
      'done',
    ])
    expect(emitted.find((event) => event.type === 'usage')).toMatchObject({
      promptTokens: 123,
      completionTokens: 45,
      costUsd: 0,
    })

    const since = new Date(Date.now() - 60_000).toISOString()
    const totals = await getUsageTotals(harness.db, since)
    expect(totals.promptTokens).toBe(123)
    expect(totals.completionTokens).toBe(45)
    expect(totals.chatCount).toBe(1)

    const [scope] = await getUsageByScope(harness.db, since)
    expect(scope).toMatchObject({
      scope: 'site',
      promptTokens: 123,
      completionTokens: 45,
      chatCount: 1,
    })

    const [model] = await getUsageByModel(harness.db, since)
    expect(model).toMatchObject({
      providerId: 'ollama',
      modelId: 'e2e-model',
      promptTokens: 123,
      completionTokens: 45,
      chatCount: 1,
    })
  })
})
