import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import {
  appendMessage,
  createConversationForUser,
  softDeleteConversationForUser,
} from '../../../server/ai/conversations/store'

describe('conversation image delivery', () => {
  let harness: CapabilityTestHarness
  let ownerCookie: string
  let ownerId: string

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    ownerCookie = await harness.setupOwner()
    const { rows } = await harness.db<{ id: string }>`select id from users limit 1`
    ownerId = rows[0]!.id
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('projects lazy URLs and serves only an owned live JPEG block', async () => {
    await harness.db`
      insert into ai_provider_credentials (
        id, user_id, provider_id, auth_mode, display_label, base_url
      ) values ('cred-image-view', ${ownerId}, 'ollama', 'baseUrl', 'Images', 'http://local')
    `
    const conversation = await createConversationForUser(harness.db, ownerId, {
      scope: 'site',
      credentialId: 'cred-image-view',
      modelId: 'vision-model',
    })
    const bytes = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 12, g: 34, b: 56 },
      },
    }).jpeg().toBuffer()
    const message = await appendMessage(harness.db, conversation.id, {
      role: 'user',
      content: [
        { kind: 'text', text: 'Reference' },
        { kind: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') },
      ],
    })

    const detailResponse = await harness.ai(
      `/admin/api/ai/conversations/${conversation.id}`,
      { cookie: ownerCookie },
    )
    expect(detailResponse.status).toBe(200)
    const detailText = await detailResponse.text()
    expect(detailText).not.toContain(bytes.toString('base64'))
    const detail = JSON.parse(detailText) as {
      conversation: { messages: Array<{ content: Array<Record<string, unknown>> }> }
    }
    const image = detail.conversation.messages[0]!.content[1]!
    expect(image).toEqual({
      kind: 'image',
      mimeType: 'image/jpeg',
      url: `/admin/api/ai/conversations/${conversation.id}/messages/${message.id}/images/1`,
    })

    const response = await harness.ai(String(image.url), { cookie: ownerCookie })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)

    const textBlock = await harness.ai(
      `/admin/api/ai/conversations/${conversation.id}/messages/${message.id}/images/0`,
      { cookie: ownerCookie },
    )
    expect(textBlock.status).toBe(404)

    const outsider = await harness.createRoleUser({
      name: 'Chat reader',
      slug: 'chat-reader',
      capabilities: ['ai.chat'],
    })
    expect((await harness.ai(String(image.url), { cookie: outsider.cookie })).status).toBe(404)

    await softDeleteConversationForUser(harness.db, ownerId, conversation.id)
    expect((await harness.ai(String(image.url), { cookie: ownerCookie })).status).toBe(404)
  })
})
