/**
 * Conversations + messages repository — CRUD over `ai_conversations` and
 * `ai_messages`.
 *
 * Per-user, per-scope. Every query carries `user_id` as a cross-user guard
 * (defence in depth on top of handler-level capability gating).
 *
 * Soft-delete via `deleted_at`; the nightly purge job (`purge.ts`)
 * hard-deletes rows older than 30 days.
 */

import { nanoid } from 'nanoid'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { AiContentBlockSchema } from '@core/ai'
import type { DbClient } from '../../db/client'
import { isoDateOrNull } from '@core/utils/isoDate'
import type { AiContentBlock, ToolScope } from '../runtime/types'
import type {
  AppendMessageInput,
  ConversationDetailView,
  ConversationRecord,
  ConversationView,
  CreateConversationInput,
  MessageRecord,
  MessageRole,
  MessageView,
  UpdateConversationInput,
} from './types'

// ---------------------------------------------------------------------------
// Row shapes ↔ records
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string
  user_id: string
  scope: string
  title: string
  credential_id: string | null
  model_id: string
  prompt_tokens_total: number | string
  completion_tokens_total: number | string
  cost_usd_total: number | string
  cache_read_tokens_total: number | string
  cache_creation_tokens_total: number | string
  context_tokens: number | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}

interface MessageRow {
  id: string
  conversation_id: string
  position: number
  role: string
  // Both dialects auto-hydrate `_json` columns to JS values (SQLite via the
  // adapter's parseJsonColumns; PG via jsonb). The row arrives already-parsed.
  content_json: unknown
  tool_call_id: string | null
  tool_name: string | null
  prompt_tokens: number
  completion_tokens: number
  cost_usd: number | string
  cache_read_tokens: number
  cache_creation_tokens: number
  created_at: Date | string
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value)
}

function conversationRowToRecord(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope as ToolScope,
    title: row.title,
    credentialId: row.credential_id,
    modelId: row.model_id,
    promptTokensTotal: toNumber(row.prompt_tokens_total),
    completionTokensTotal: toNumber(row.completion_tokens_total),
    costUsdTotal: toNumber(row.cost_usd_total),
    cacheReadTokensTotal: toNumber(row.cache_read_tokens_total),
    cacheCreationTokensTotal: toNumber(row.cache_creation_tokens_total),
    contextTokens: toNumber(row.context_tokens),
    createdAt: isoDateOrNull(row.created_at)!,
    updatedAt: isoDateOrNull(row.updated_at)!,
    deletedAt: isoDateOrNull(row.deleted_at),
  }
}

const ContentBlocksSchema = Type.Array(AiContentBlockSchema)

function parseContentBlocks(raw: unknown): AiContentBlock[] {
  // SQLite adapter + PG jsonb both deliver this column pre-parsed. This is the
  // read boundary: every block is validated against the canonical
  // `AiContentBlockSchema`, so callers (e.g. `buildMessageHistory`) receive a
  // fully-typed `AiContentBlock[]` and never re-cast.
  const parsed = safeParseValue(ContentBlocksSchema, raw)
  if (!parsed.ok) {
    // Defensive: don't crash an entire history fetch over one bad row.
    console.error('[ai/conversations] Malformed content_json row, returning empty blocks.')
    return []
  }
  return parsed.value
}

function messageRowToRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    position: row.position,
    role: row.role as MessageRole,
    content: parseContentBlocks(row.content_json),
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    costUsd: toNumber(row.cost_usd),
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    createdAt: isoDateOrNull(row.created_at)!,
  }
}

// ---------------------------------------------------------------------------
// Wire projections
// ---------------------------------------------------------------------------

export function toConversationView(record: ConversationRecord): ConversationView {
  return {
    id: record.id,
    scope: record.scope,
    title: record.title,
    credentialId: record.credentialId,
    modelId: record.modelId,
    promptTokensTotal: record.promptTokensTotal,
    completionTokensTotal: record.completionTokensTotal,
    costUsdTotal: record.costUsdTotal,
    cacheReadTokensTotal: record.cacheReadTokensTotal,
    cacheCreationTokensTotal: record.cacheCreationTokensTotal,
    contextTokens: record.contextTokens,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function toMessageView(record: MessageRecord): MessageView {
  return {
    id: record.id,
    position: record.position,
    role: record.role,
    content: record.content,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    createdAt: record.createdAt,
  }
}

export function toConversationDetailView(
  conversation: ConversationRecord,
  messages: MessageRecord[],
): ConversationDetailView {
  return {
    ...toConversationView(conversation),
    messages: messages.map(toMessageView),
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List non-deleted conversations for one user + scope, newest activity
 * first. Served by the `ai_conv_user_scope_idx` partial index.
 */
export async function listConversationsForUserScope(
  db: DbClient,
  userId: string,
  scope: ToolScope,
): Promise<ConversationRecord[]> {
  const { rows } = await db<ConversationRow>`
    select id, user_id, scope, title, credential_id, model_id,
           prompt_tokens_total, completion_tokens_total,
           cost_usd_total, cache_read_tokens_total, cache_creation_tokens_total,
           context_tokens, created_at, updated_at, deleted_at
    from ai_conversations
    where user_id = ${userId}
      and scope = ${scope}
      and deleted_at is null
    order by updated_at desc
  `
  return rows.map(conversationRowToRecord)
}

/**
 * Read a single conversation with cross-user guard. Returns null for not
 * found / not yours / soft-deleted.
 */
export async function readConversationForUser(
  db: DbClient,
  userId: string,
  conversationId: string,
): Promise<ConversationRecord | null> {
  const { rows } = await db<ConversationRow>`
    select id, user_id, scope, title, credential_id, model_id,
           prompt_tokens_total, completion_tokens_total,
           cost_usd_total, cache_read_tokens_total, cache_creation_tokens_total,
           context_tokens, created_at, updated_at, deleted_at
    from ai_conversations
    where id = ${conversationId}
      and user_id = ${userId}
      and deleted_at is null
    limit 1
  `
  return rows[0] ? conversationRowToRecord(rows[0]) : null
}

/**
 * Read every message of a conversation in position order. Caller must have
 * already verified ownership via `readConversationForUser`.
 */
export async function listMessagesForConversation(
  db: DbClient,
  conversationId: string,
): Promise<MessageRecord[]> {
  const { rows } = await db<MessageRow>`
    select id, conversation_id, position, role, content_json,
           tool_call_id, tool_name,
           prompt_tokens, completion_tokens, cost_usd,
           cache_read_tokens, cache_creation_tokens, created_at
    from ai_messages
    where conversation_id = ${conversationId}
    order by position asc
  `
  return rows.map(messageRowToRecord)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a new conversation row. `title` defaults to "New conversation" —
 * the runner can rename it after the first user message lands (or the UI
 * can offer "Rename this chat").
 */
export async function createConversationForUser(
  db: DbClient,
  userId: string,
  input: CreateConversationInput,
): Promise<ConversationRecord> {
  const id = nanoid()
  const title = (input.title ?? '').trim() || 'New conversation'
  const { rows } = await db<ConversationRow>`
    insert into ai_conversations (
      id, user_id, scope, title, credential_id, model_id
    )
    values (
      ${id}, ${userId}, ${input.scope}, ${title},
      ${input.credentialId}, ${input.modelId}
    )
    returning id, user_id, scope, title, credential_id, model_id,
              prompt_tokens_total, completion_tokens_total,
              cost_usd_total, cache_read_tokens_total, cache_creation_tokens_total,
           context_tokens, created_at, updated_at, deleted_at
  `
  return conversationRowToRecord(rows[0]!)
}

/**
 * Patch a conversation. Pass only fields to update.
 */
export async function updateConversationForUser(
  db: DbClient,
  userId: string,
  conversationId: string,
  patch: UpdateConversationInput,
): Promise<ConversationRecord | null> {
  const existing = await readConversationForUser(db, userId, conversationId)
  if (!existing) return null

  const nextTitle = patch.title?.trim() || existing.title
  const nextCredentialId =
    patch.credentialId !== undefined ? patch.credentialId : existing.credentialId
  const nextModelId =
    patch.modelId !== undefined ? patch.modelId : existing.modelId

  const { rows } = await db<ConversationRow>`
    update ai_conversations
    set title = ${nextTitle},
        credential_id = ${nextCredentialId},
        model_id = ${nextModelId},
        updated_at = current_timestamp
    where id = ${conversationId} and user_id = ${userId}
    returning id, user_id, scope, title, credential_id, model_id,
              prompt_tokens_total, completion_tokens_total,
              cost_usd_total, cache_read_tokens_total, cache_creation_tokens_total,
           context_tokens, created_at, updated_at, deleted_at
  `
  return rows[0] ? conversationRowToRecord(rows[0]) : null
}

/**
 * Soft-delete by setting `deleted_at`. Idempotent — calling on an
 * already-deleted row sets deleted_at to the current time again.
 * Returns true when a row was matched.
 */
export async function softDeleteConversationForUser(
  db: DbClient,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const result = await db`
    update ai_conversations
    set deleted_at = current_timestamp,
        updated_at = current_timestamp
    where id = ${conversationId} and user_id = ${userId}
  `
  return result.rowCount > 0
}

/**
 * Append a message to an existing conversation. Computes the next
 * `position` from a SELECT MAX(position) — small race in the (rare) case
 * of two writers, but conversations are single-writer (one stream per
 * conversation at a time, enforced by the handler).
 *
 * Also bumps the parent conversation's `updated_at` + token + cost totals
 * so list queries pick up activity immediately.
 */
export async function appendMessage(
  db: DbClient,
  conversationId: string,
  input: AppendMessageInput,
): Promise<MessageRecord> {
  return db.transaction(async (tx) => {
    const { rows: posRows } = await tx<{ next_pos: number }>`
      select coalesce(max(position), -1) + 1 as next_pos
      from ai_messages
      where conversation_id = ${conversationId}
    `
    const position = posRows[0]?.next_pos ?? 0
    const id = nanoid()
    const promptTokens = input.promptTokens ?? 0
    const completionTokens = input.completionTokens ?? 0
    const costUsd = input.costUsd ?? 0
    const cacheReadTokens = input.cacheReadTokens ?? 0
    const cacheCreationTokens = input.cacheCreationTokens ?? 0

    // Pass content as a plain array; both dialect adapters handle the JSON
    // encoding (SQLite auto-stringify on bind for objects; PG jsonb native).
    const { rows: msgRows } = await tx<MessageRow>`
      insert into ai_messages (
        id, conversation_id, position, role, content_json,
        tool_call_id, tool_name,
        prompt_tokens, completion_tokens, cost_usd,
        cache_read_tokens, cache_creation_tokens
      )
      values (
        ${id}, ${conversationId}, ${position}, ${input.role}, ${input.content},
        ${input.toolCallId ?? null}, ${input.toolName ?? null},
        ${promptTokens}, ${completionTokens}, ${costUsd},
        ${cacheReadTokens}, ${cacheCreationTokens}
      )
      returning id, conversation_id, position, role, content_json,
                tool_call_id, tool_name,
                prompt_tokens, completion_tokens, cost_usd,
                cache_read_tokens, cache_creation_tokens, created_at
    `

    // Denormalised totals on the parent — kept in sync per-append so list
    // queries don't need to aggregate.
    await tx`
      update ai_conversations
      set prompt_tokens_total = prompt_tokens_total + ${promptTokens},
          completion_tokens_total = completion_tokens_total + ${completionTokens},
          cost_usd_total = cost_usd_total + ${costUsd},
          cache_read_tokens_total = cache_read_tokens_total + ${cacheReadTokens},
          cache_creation_tokens_total = cache_creation_tokens_total + ${cacheCreationTokens},
          updated_at = current_timestamp
      where id = ${conversationId}
    `

    return messageRowToRecord(msgRows[0]!)
  })
}

// ---------------------------------------------------------------------------
// Purge — used by the nightly tick job (purge.ts).
// ---------------------------------------------------------------------------

/**
 * Hard-delete soft-deleted conversations older than `cutoffIsoString`.
 * Cascading FK takes the messages with them.
 *
 * Returns the number of CONVERSATIONS purged (counted before delete) — not
 * the raw `rowCount`, which on SQLite includes cascaded message deletions
 * and would mislead the caller.
 */
export async function purgeSoftDeletedOlderThan(
  db: DbClient,
  cutoffIsoString: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx<{ c: number | string }>`
      select count(*) as c
      from ai_conversations
      where deleted_at is not null
        and deleted_at < ${cutoffIsoString}
    `
    const count = toNumber(rows[0]?.c ?? 0)
    if (count > 0) {
      await tx`
        delete from ai_conversations
        where deleted_at is not null
          and deleted_at < ${cutoffIsoString}
      `
    }
    return count
  })
}
