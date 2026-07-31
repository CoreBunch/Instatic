import { describe, expect, test } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import {
  AI_CHAT_MAX_REQUEST_BYTES,
  AI_USER_IMAGE_MAX_BASE64_CHARS,
  AI_USER_IMAGE_MAX_PER_MESSAGE,
  AiChatRequestBodySchema,
  isAiUserImageSourceMimeType,
} from '@core/ai'

const image = {
  kind: 'image' as const,
  mimeType: 'image/jpeg' as const,
  data: 'AAAA',
}

describe('AiChatRequestBodySchema', () => {
  test('accepts text-only, image-only, and multi-image user turns', () => {
    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: [{ kind: 'text', text: 'Hello' }],
      snapshot: { pageId: 'page-1' },
    })).toBe(true)

    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: [image],
    })).toBe(true)

    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: [image, { kind: 'text', text: 'Compare these' }, image],
    })).toBe(true)
  })

  test('rejects empty content and assistant/tool block injection', () => {
    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: [],
    })).toBe(false)

    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: [{ kind: 'toolCall', toolCallId: 'call-1', toolName: 'site_insert_html', input: {} }],
    })).toBe(false)

    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: [{ kind: 'toolResult', ok: true }],
    })).toBe(false)
  })

  test('bounds the user turn to one text block and eight normalised JPEGs', () => {
    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: [{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }, image],
    })).toBe(false)

    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: [{ ...image, mimeType: 'image/png' }],
    })).toBe(false)

    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: [{ ...image, data: 'A'.repeat(AI_USER_IMAGE_MAX_BASE64_CHARS + 1) }],
    })).toBe(false)

    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: Array.from({ length: AI_USER_IMAGE_MAX_PER_MESSAGE }, () => image),
    })).toBe(true)

    expect(Value.Check(AiChatRequestBodySchema, {
      conversationId: 'conversation-1',
      content: Array.from({ length: AI_USER_IMAGE_MAX_PER_MESSAGE + 1 }, () => image),
    })).toBe(false)
  })

  test('reserves snapshot overhead above eight maximum base64 image blocks', () => {
    expect(AI_CHAT_MAX_REQUEST_BYTES).toBeGreaterThan(
      AI_USER_IMAGE_MAX_PER_MESSAGE * AI_USER_IMAGE_MAX_BASE64_CHARS,
    )
  })
})

describe('AI user-image source MIME guard', () => {
  test('accepts browser-normalisable raster formats and rejects unsupported input', () => {
    expect(isAiUserImageSourceMimeType('image/jpeg')).toBe(true)
    expect(isAiUserImageSourceMimeType('image/png')).toBe(true)
    expect(isAiUserImageSourceMimeType('image/webp')).toBe(true)
    expect(isAiUserImageSourceMimeType('image/gif')).toBe(false)
    expect(isAiUserImageSourceMimeType('image/svg+xml')).toBe(false)
  })
})
