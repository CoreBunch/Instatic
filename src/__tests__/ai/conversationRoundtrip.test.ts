import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import sharp from 'sharp'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  appendMessage,
  createConversationForUser,
  listMessagesForConversation,
  readConversationForUser,
  replaceDefaultConversationTitle,
  toConversationDetailView,
  updateConversationForUser,
} from '../../../server/ai/conversations/store'
import { ConversationDetailViewSchema } from '../../admin/ai/api'

/**
 * Regression guard for the conversation-reopen bug: the conversation detail
 * payload must validate against the client's `ConversationDetailViewSchema`
 * after a full DB round-trip. The original bug stored an editor snapshot in a
 * `context_json` column — on SQLite the `*_json` adapter auto-parsed it back to
 * an object, which the client schema (declaring it `string | null`) rejected
 * with "Expected union value", so reopening any conversation with a context
 * failed. The column is gone; this test ensures the detail view stays
 * wire-valid on the SQLite path that exhibited the bug.
 */
describe('conversation detail round-trip', () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await createTestDb()
    await testDb.db`
      insert into users (id, email, email_normalized, display_name, password_hash, status, role_id)
      values ('user_1', 'a@a.com', 'a@a.com', 'A', 'x', 'active', 'admin')
    `
    await testDb.db`
      insert into ai_provider_credentials (id, user_id, provider_id, auth_mode, display_label, base_url)
      values ('cred_1', 'user_1', 'ollama', 'baseUrl', 'Test', 'http://localhost:11434')
    `
  })

  afterEach(async () => {
    await testDb.cleanup()
  })

  it('produces a wire-valid detail view after create + append', async () => {
    const conv = await createConversationForUser(testDb.db, 'user_1', {
      scope: 'site',
      credentialId: 'cred_1',
      modelId: 'model_1',
    })

    await appendMessage(testDb.db, conv.id, {
      role: 'user',
      content: [{ kind: 'text', text: 'hello' }],
    })

    const record = await readConversationForUser(testDb.db, 'user_1', conv.id)
    expect(record).not.toBeNull()

    const messages = await listMessagesForConversation(testDb.db, conv.id)
    const detail = toConversationDetailView(record!, messages, () => '/unused-image')

    // The exact validator that threw "Expected union value" on reopen.
    expect(Value.Check(ConversationDetailViewSchema, detail)).toBe(true)
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0]!.content).toEqual([{ kind: 'text', text: 'hello' }])
    // The dead context field must not reappear on the wire shape.
    expect('contextJson' in detail).toBe(false)
  })

  it('preserves mixed and image-only user content through SQLite and the wire schema', async () => {
    const conv = await createConversationForUser(testDb.db, 'user_1', {
      scope: 'site',
      credentialId: 'cred_1',
      modelId: 'model_1',
    })
    const imageData = (await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()).toString('base64')
    const image = { kind: 'image' as const, mimeType: 'image/jpeg', data: imageData }

    await appendMessage(testDb.db, conv.id, {
      role: 'user',
      content: [{ kind: 'text', text: 'What is this?' }, image],
    })
    await appendMessage(testDb.db, conv.id, {
      role: 'user',
      content: [image],
    })

    const record = await readConversationForUser(testDb.db, 'user_1', conv.id)
    expect(record).not.toBeNull()
    const messages = await listMessagesForConversation(testDb.db, conv.id)
    const detail = toConversationDetailView(
      record!,
      messages,
      (messageId, blockIndex) => `/images/${messageId}/${blockIndex}`,
    )

    expect(Value.Check(ConversationDetailViewSchema, detail)).toBe(true)
    expect(messages.map((message) => message.content)).toEqual([
      [{ kind: 'text', text: 'What is this?' }, image],
      [image],
    ])
    expect(detail.messages.map((message) => message.content)).toEqual([
      [
        { kind: 'text', text: 'What is this?' },
        {
          kind: 'image',
          mimeType: 'image/jpeg',
          url: `/images/${messages[0]!.id}/1`,
        },
      ],
      [{
        kind: 'image',
        mimeType: 'image/jpeg',
        url: `/images/${messages[1]!.id}/0`,
      }],
    ])
    expect(JSON.stringify(detail)).not.toContain(imageData)
  })

  it('does not let an automatic first-turn title overwrite a user rename', async () => {
    const conv = await createConversationForUser(testDb.db, 'user_1', {
      scope: 'site',
      credentialId: 'cred_1',
      modelId: 'model_1',
    })
    await updateConversationForUser(testDb.db, 'user_1', conv.id, {
      title: 'My reference review',
    })

    expect(await replaceDefaultConversationTitle(
      testDb.db,
      'user_1',
      conv.id,
      'Image',
    )).toBe(false)
    expect((await readConversationForUser(testDb.db, 'user_1', conv.id))?.title)
      .toBe('My reference review')
  })
})
