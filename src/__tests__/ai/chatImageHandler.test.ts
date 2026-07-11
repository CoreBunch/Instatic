import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { AI_CHAT_MAX_REQUEST_BYTES, AI_CONVERSATION_MAX_USER_IMAGES } from '@core/ai'
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

  it('enforces the persisted user-image budget before appending another turn', async () => {
    const image = await jpegBlock()
    for (let index = 0; index < AI_CONVERSATION_MAX_USER_IMAGES; index += 1) {
      await appendMessage(harness.db, conversationId, { role: 'user', content: [image] })
    }

    const response = await harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: { conversationId, content: [image] },
    })

    expect(response.status).toBe(413)
    expect(await listMessagesForConversation(harness.db, conversationId))
      .toHaveLength(AI_CONVERSATION_MAX_USER_IMAGES)
  })

  it('persists an image-only turn and titles a new conversation Image', async () => {
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
      json: { conversationId, content: [image] },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await response.text()
    const { rows } = await harness.db<{ id: string }>`select id from users limit 1`
    const conversation = await readConversationForUser(harness.db, rows[0]!.id, conversationId)
    const messages = await listMessagesForConversation(harness.db, conversationId)

    expect(conversation?.title).toBe('Image')
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toHaveLength(1)
    const persistedImage = messages[0]?.content[0]
    expect(persistedImage).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' })
    if (persistedImage?.kind !== 'image') throw new Error('Expected persisted image block')
    expect(providerRequest).toContain(`data:image/jpeg;base64,${persistedImage.data}`)
    expect((JSON.parse(providerRequest) as { tools?: unknown }).tools).toBeArray()
  })

  it('allows only one concurrent writer at the eight-image boundary', async () => {
    const image = await jpegBlock()
    for (let index = 0; index < AI_CONVERSATION_MAX_USER_IMAGES - 1; index += 1) {
      await appendMessage(harness.db, conversationId, { role: 'user', content: [image] })
    }

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
    expect(persistedUserImages).toHaveLength(AI_CONVERSATION_MAX_USER_IMAGES)
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

  it('re-reads the image budget after a slower request reaches the writer lease', async () => {
    const image = await jpegBlock()
    for (let index = 0; index < AI_CONVERSATION_MAX_USER_IMAGES - 1; index += 1) {
      await appendMessage(harness.db, conversationId, { role: 'user', content: [image] })
    }
    const slowCapabilityStarted = deferred<void>()
    const slowCapabilityResponse = deferred<Response>()
    globalThis.fetch = async (input) => {
      const url = requestUrl(input)
      if (url === 'http://ollama.test/api/show') {
        slowCapabilityStarted.resolve()
        return slowCapabilityResponse.promise
      }
      if (url === 'http://ollama-fast.test/api/show') {
        return jsonResponse({ capabilities: ['vision', 'tools'] })
      }
      if (url === 'http://ollama-fast.test/v1/chat/completions') {
        return new Response([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }

    const slowRequest = harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: { conversationId, content: [image] },
    })
    await slowCapabilityStarted.promise
    await harness.db`
      update ai_provider_credentials
      set base_url = 'http://ollama-fast.test'
      where id = ${credentialId}
    `

    const fastResponse = await harness.ai('/admin/api/ai/chat/site', {
      method: 'POST',
      cookie,
      json: { conversationId, content: [image] },
    })
    expect(fastResponse.status).toBe(200)
    await fastResponse.text()

    slowCapabilityResponse.resolve(jsonResponse({ capabilities: ['vision', 'tools'] }))
    const slowResponse = await slowRequest
    expect(slowResponse.status).toBe(413)

    const userImages = (await listMessagesForConversation(harness.db, conversationId))
      .filter((message) => message.role === 'user')
      .flatMap((message) => message.content)
      .filter((block) => block.kind === 'image')
    expect(userImages).toHaveLength(AI_CONVERSATION_MAX_USER_IMAGES)
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
