import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  createConversationForUser,
  listMessagesForConversation,
} from '../../../server/ai/conversations/store'
import { createConversationsPersister } from '../../../server/ai/runtime/persister'
import { buildMessageHistory } from '../../../server/ai/conversations/history'
import type { AiMessage } from '../../../server/ai/runtime/types'

/**
 * Regression guard for the steganographic tool-result encoding. Tool success
 * used to be stored as "empty text block == ok"; this round-trips a SUCCESSFUL
 * and a FAILED tool result through the real persist path (createConversationsPersister
 * → ai_messages) and back out through buildMessageHistory, asserting that
 * `ok`/`error` survive intact — and that the persisted block is a first-class
 * `toolResult` block, not an inferred empty text block.
 */
describe('tool-result persist → buildMessageHistory round-trip', () => {
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

  it('preserves ok and error through a full DB round-trip', async () => {
    const conv = await createConversationForUser(testDb.db, 'user_1', {
      scope: 'site',
      credentialId: 'cred_1',
      modelId: 'model_1',
    })

    const persister = createConversationsPersister(testDb.db, conv.id, {
      providerId: 'ollama',
      modelId: 'model_1',
    })

    // A successful call: no error, no persisted data.
    await persister.appendToolCall({ toolCallId: 'ok1', toolName: 'site_read_document', input: { a: 1 } })
    await persister.appendToolResult({ toolCallId: 'ok1', toolName: 'site_read_document', ok: true })

    // A failed call: carries an error message.
    await persister.appendToolCall({ toolCallId: 'err1', toolName: 'site_insert_html', input: {} })
    await persister.appendToolResult({
      toolCallId: 'err1',
      toolName: 'site_insert_html',
      ok: false,
      error: 'boom',
    })

    const records = await listMessagesForConversation(testDb.db, conv.id)

    // The persisted shape is an honest first-class block — not an empty text block.
    const toolRows = records.filter((r) => r.role === 'tool')
    expect(toolRows).toHaveLength(2)
    expect(toolRows[0]!.content).toEqual([{ kind: 'toolResult', ok: true }])
    expect(toolRows[1]!.content).toEqual([{ kind: 'toolResult', ok: false, error: 'boom' }])

    // Replay reconstructs the AiToolOutput envelope with ok/error intact.
    const history = buildMessageHistory(records)
    const byId = Object.fromEntries(
      history
        .filter((m): m is Extract<AiMessage, { role: 'tool' }> => m.role === 'tool')
        .map((m) => [m.toolCallId, m.output]),
    )

    expect(byId['ok1']).toEqual({ ok: true, error: undefined })
    expect(byId['err1']).toEqual({ ok: false, error: 'boom' })
  })
})
