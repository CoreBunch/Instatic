import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  appendMessage,
  createConversationForUser,
  listMessagesForConversation,
  readConversationForUser,
  toConversationDetailView,
} from '../../../server/ai/conversations/store'
import { buildMessageHistory } from '../../../server/ai/conversations/history'
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
    const detail = toConversationDetailView(record!, messages)

    // The exact validator that threw "Expected union value" on reopen.
    expect(Value.Check(ConversationDetailViewSchema, detail)).toBe(true)
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0]!.content).toEqual([{ kind: 'text', text: 'hello' }])
    // The dead context field must not reappear on the wire shape.
    expect('contextJson' in detail).toBe(false)
  })

  it('persists and replays a pasted image attachment on the user message', async () => {
    const conv = await createConversationForUser(testDb.db, 'user_1', {
      scope: 'site',
      credentialId: 'cred_1',
      modelId: 'model_1',
    })

    // Mirror what chat.ts does: append text + one image block.
    await appendMessage(testDb.db, conv.id, {
      role: 'user',
      content: [
        { kind: 'text', text: 'What does this mockup show?' },
        { kind: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ],
    })

    const record = await readConversationForUser(testDb.db, 'user_1', conv.id)
    expect(record).not.toBeNull()

    const messages = await listMessagesForConversation(testDb.db, conv.id)
    const detail = toConversationDetailView(record!, messages)

    // The detail view stays wire-valid with the image block present.
    expect(Value.Check(ConversationDetailViewSchema, detail)).toBe(true)
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0]!.content).toEqual([
      { kind: 'text', text: 'What does this mockup show?' },
      { kind: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ])

    // buildMessageHistory (what the driver replays each turn) carries the
    // image block verbatim so the model sees the pasted image on follow-ups.
    const history = buildMessageHistory(messages)
    const userTurn = history.find((m) => m.role === 'user')
    expect(userTurn?.content).toEqual([
      { kind: 'text', text: 'What does this mockup show?' },
      { kind: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ])
  })
})
