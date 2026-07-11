import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { AI_CHAT_MAX_REQUEST_BYTES, AI_USER_IMAGE_MAX_PER_MESSAGE } from '@core/ai'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import {
  appendMessage,
  createConversationForUser,
  listMessagesForConversation,
  readConversationForUser,
} from '../../../server/ai/conversations/store'

let testSerial = 0

describe('AI chat user-image boundary', () => {
  let harness: CapabilityTestHarness
  let cookie: string
  let conversationId: string
  let credentialId: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    harness = await createCapabilityTestHarness()
    cookie = await harness.setupOwner()
    const { rows } = await harness.db<{ id: string }>`select id from users limit 1`
    const userId = rows[0]!.id
    credentialId = `cred_image_${++testSerial}`
    await harness.db`
      insert into ai_provider_credentials (
        id, user_id, provider_id, auth_mode, display_label, base_url
      ) values (
        ${credentialId}, ${userId}, 'ollama', 'baseUrl', 'Image test', 'http://ollama.test'
      )
    `
    const conversation = await createConversationForUser(harness.db, userId, {
      scope: 'site',
      credentialId,
      modelId: 'vision-model',
    })
    conversationId = conversation.id
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await harness.cleanup()
  })

  it('returns 413 when the complete request envelope exceeds its limit', async () => {
    const response = await harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: {
        conversationId,
        content: [{ kind: 'text', text: 'x'.repeat(AI_CHAT_MAX_REQUEST_BYTES) }],
      },
    })

    expect(response.status).toBe(413)
    expect(await listMessagesForConversation(harness.db, conversationId)).toHaveLength(0)
  })

  it('rejects malformed JPEG bytes before persistence', async () => {
    const response = await harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: {
        conversationId,
        content: [{ kind: 'image', mimeType: 'image/jpeg', data: '/9h/' }],
      },
    })

    expect(response.status).toBe(400)
    expect(await listMessagesForConversation(harness.db, conversationId)).toHaveLength(0)
  })

  it('rejects a non-vision model before persistence', async () => {
    const image = await jpegBlock()
    globalThis.fetch = async (input) => {
      const url = requestUrl(input)
      if (url === 'http://ollama.test/api/tags') {
        return jsonResponse({ models: [{ name: 'vision-model' }] })
      }
      if (url === 'http://ollama.test/api/show') {
        return jsonResponse({ capabilities: ['completion'] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }

    const response = await harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: { conversationId, content: [image] },
    })

    expect(response.status).toBe(422)
    expect(await listMessagesForConversation(harness.db, conversationId)).toHaveLength(0)
  })

  it('rejects a known non-tool model before persistence or provider streaming', async () => {
    globalThis.fetch = async (input) => {
      const url = requestUrl(input)
      if (url === 'http://ollama.test/api/show') {
        return jsonResponse({ capabilities: ['vision'] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }

    const response = await harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: {
        conversationId,
        content: [{ kind: 'text', text: 'Inspect the page.' }],
      },
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: 'The selected model does not support tool calling. Choose an agent-capable model.',
    })
    expect(await listMessagesForConversation(harness.db, conversationId)).toHaveLength(0)
  })

  it('persists a multi-image turn, forwards every image, and titles it Images', async () => {
    const image = await jpegBlock()
    let providerRequest = ''
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url === 'http://ollama.test/api/tags') {
        return jsonResponse({ models: [{ name: 'vision-model' }] })
      }
      if (url === 'http://ollama.test/api/show') {
        return jsonResponse({ capabilities: ['vision', 'tools'] })
      }
      if (url === 'http://ollama.test/v1/chat/completions') {
        providerRequest = String(init?.body ?? '')
        return new Response([
          'data: {"choices":[{"delta":{"content":"Looks good."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ].join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }

    const response = await harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: { conversationId, content: [image, image] },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await response.text()
    const { rows } = await harness.db<{ id: string }>`select id from users limit 1`
    const conversation = await readConversationForUser(harness.db, rows[0]!.id, conversationId)
    const messages = await listMessagesForConversation(harness.db, conversationId)

    expect(conversation?.title).toBe('Images')
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toHaveLength(2)
    const persistedImages = messages[0]?.content.filter((block) => block.kind === 'image') ?? []
    expect(persistedImages).toHaveLength(2)
    expect(providerRequest.match(/data:image\/jpeg;base64,/g)).toHaveLength(2)
    expect((JSON.parse(providerRequest) as { tools?: unknown }).tools).toBeArray()
  })

  it('allows only one concurrent writer', async () => {
    const image = await jpegBlock()
    const capabilityStarted = deferred<void>()
    const capabilityResponse = deferred<Response>()
    const providerResponse = deferred<Response>()
    globalThis.fetch = async (input) => {
      const url = requestUrl(input)
      if (url === 'http://ollama.test/api/show') {
        capabilityStarted.resolve()
        return capabilityResponse.promise
      }
      if (url === 'http://ollama.test/v1/chat/completions') {
        return providerResponse.promise
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }

    const firstRequest = harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: { conversationId, content: [image] },
    })
    await capabilityStarted.promise
    const secondRequest = harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: { conversationId, content: [image] },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    capabilityResponse.resolve(jsonResponse({ capabilities: ['vision', 'tools'] }))

    const responses = await Promise.all([firstRequest, secondRequest])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])

    providerResponse.resolve(new Response([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }))
    const accepted = responses.find((response) => response.status === 200)
    await accepted?.text()

    const messages = await listMessagesForConversation(harness.db, conversationId)
    const persistedUserImages = messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => message.content)
      .filter((block) => block.kind === 'image')
    expect(persistedUserImages).toHaveLength(1)
  })

  it('does not persist a turn aborted during capability discovery', async () => {
    const image = await jpegBlock()
    const capabilityStarted = deferred<void>()
    const capabilityResponse = deferred<Response>()
    globalThis.fetch = async (input) => {
      const url = requestUrl(input)
      if (url !== 'http://ollama.test/api/show') {
        throw new Error(`Unexpected fetch: ${url}`)
      }
      capabilityStarted.resolve()
      return capabilityResponse.promise
    }
    const controller = new AbortController()

    const request = harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      signal: controller.signal,
      json: { conversationId, content: [image] },
    })
    await capabilityStarted.promise
    controller.abort()

    const response = await request
    expect(response.status).toBe(499)
    expect(await listMessagesForConversation(harness.db, conversationId)).toHaveLength(0)

    // Let the shared lookup settle so it cannot leak into a later test.
    capabilityResponse.resolve(jsonResponse({ capabilities: ['vision', 'tools'] }))
  })

  it('retains images across turns beyond the per-message limit', async () => {
    const image = await jpegBlock()
    for (let index = 0; index < AI_USER_IMAGE_MAX_PER_MESSAGE; index += 1) {
      await appendMessage(harness.db, conversationId, { role: 'user', content: [image] })
    }
    let providerRequest = ''
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url === 'http://ollama.test/api/show') {
        return jsonResponse({ capabilities: ['vision', 'tools'] })
      }
      if (url === 'http://ollama.test/v1/chat/completions') {
        providerRequest = String(init?.body ?? '')
        return new Response([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }

    const response = await harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: { conversationId, content: [image, image] },
    })
    expect(response.status).toBe(200)
    await response.text()

    const userImages = (await listMessagesForConversation(harness.db, conversationId))
      .filter((message) => message.role === 'user')
      .flatMap((message) => message.content)
      .filter((block) => block.kind === 'image')
    expect(userImages).toHaveLength(AI_USER_IMAGE_MAX_PER_MESSAGE + 2)
    expect(providerRequest.match(/data:image\/jpeg;base64,/g))
      .toHaveLength(AI_USER_IMAGE_MAX_PER_MESSAGE + 2)
  })
})

async function jpegBlock() {
  const data = (await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 30, g: 60, b: 90 },
    },
  }).jpeg().toBuffer()).toString('base64')
  return { kind: 'image' as const, mimeType: 'image/jpeg' as const, data }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
