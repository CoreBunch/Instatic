/**
 * Persistence sink the runner uses to commit assistant text, tool calls,
 * tool results, and usage totals to the conversation as a chat unfolds.
 *
 * Wraps `server/ai/conversations/store.ts` with the per-conversation
 * context (db client + conversation id) so the runner doesn't need to
 * thread those through every call.
 */

import type { DbClient } from '../../db/client'
import { appendMessage } from '../conversations/store'
import { resolveCostUsd } from '../pricing'
import { normalizeContextTokens } from '../contextTokens'
import type { AiContentBlock, AiProviderId } from './types'

export interface ConversationsPersister {
  appendAssistantText(text: string): Promise<void>
  appendToolCall(args: {
    toolCallId: string
    toolName: string
    input: unknown
  }): Promise<void>
  appendToolResult(args: {
    toolCallId: string
    toolName: string
    ok: boolean
    error?: string
  }): Promise<void>
  recordUsage(usage: {
    promptTokens: number
    completionTokens: number
    costUsd?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }): Promise<void>
  /**
   * Record one round's context size (input buckets). Kept in memory; the LAST
   * value seen this turn is the true "context used" and is written to the
   * conversation row by `recordUsage` at turn end. Synchronous — no DB write.
   */
  recordContext(usage: {
    promptTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }): void
}

interface ConversationsPersisterContext {
  /** Used to price `usage` events whose driver omits a `costUsd` value. */
  providerId: AiProviderId
  /** Used together with providerId to look up the per-million-token rates. */
  modelId: string
}

export function createConversationsPersister(
  db: DbClient,
  conversationId: string,
  ctx: ConversationsPersisterContext,
): ConversationsPersister {
  // Token + cost totals are kept in memory and flushed onto the LAST
  // assistant message we write per turn. Drivers report usage as a
  // single aggregate at the end; we attribute it to the assistant's
  // message row (which always exists by then — either a text reply or
  // the assistant's tool_use block that surfaced via appendToolCall).
  let lastAssistantMessageId: string | null = null
  // The latest round's provider-normalised context size. The meter wants the
  // CURRENT context (last round), not the per-round sum — so we overwrite, then
  // persist this value with the terminal usage event.
  let latestContextTokens: number | null = null

  return {
    async appendAssistantText(text) {
      const blocks: AiContentBlock[] = [{ kind: 'text', text }]
      const row = await appendMessage(db, conversationId, {
        role: 'assistant',
        content: blocks,
      })
      lastAssistantMessageId = row.id
    },

    async appendToolCall({ toolCallId, toolName, input }) {
      const blocks: AiContentBlock[] = [{
        kind: 'toolCall',
        toolCallId,
        toolName,
        input,
      }]
      const row = await appendMessage(db, conversationId, {
        role: 'assistant',
        content: blocks,
        toolCallId,
        toolName,
      })
      lastAssistantMessageId = row.id
    },

    async appendToolResult({ toolCallId, toolName, ok, error }) {
      // role='tool' messages mirror the OpenAI shape; the Anthropic driver
      // maps these to `{ role: 'user', content: [tool_result block] }`
      // when replaying history into the Messages API.
      //
      // The outcome is a first-class `toolResult` block — `ok` is explicit, not
      // inferred from an empty text block. We persist only `{ ok, error }`: the
      // heavy successful `data` the tool returned is intentionally dropped (the
      // model already consumed it in the round that produced the result;
      // re-feeding it on every replay would bloat context for no benefit).
      const blocks: AiContentBlock[] = [
        ok
          ? { kind: 'toolResult', ok: true }
          : { kind: 'toolResult', ok: false, error: error ?? 'Tool call failed.' },
      ]
      await appendMessage(db, conversationId, {
        role: 'tool',
        content: blocks,
        toolCallId,
        toolName,
      })
    },

    recordContext(usage) {
      latestContextTokens = normalizeContextTokens(ctx.providerId, {
        promptTokens: usage.promptTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      })
    },

    async recordUsage(usage) {
      // Persist usage as a denormalised update on the LAST assistant
      // message so a per-message cost view is possible later. If no
      // assistant message exists yet, the conversation totals will pick
      // up the increment anyway (appendMessage bumps them per row), so we
      // simply skip — the totals are still correct, only the per-message
      // attribution is lost in that edge case.
      if (!lastAssistantMessageId) return
      // Driver-supplied cost wins (OpenRouter reports a native per-call USD
      // cost). When absent (Anthropic, OpenAI) we price from the live
      // OpenRouter catalogue, cache-aware; Ollama is free. Token counts are
      // always trusted as reported by the driver.
      const costUsd = usage.costUsd ?? await resolveCostUsd(
        db,
        ctx.providerId,
        ctx.modelId,
        {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        },
      )
      // Provider-normalised "context used now" snapshot for the conversation
      // row, restored by the meter on reload. Prefer the LAST round's context
      // (tracked via recordContext) — the true current context size. Fall back
      // to this turn's input only if no context event arrived (e.g. a provider
      // that never reported per-round usage).
      const contextTokens = latestContextTokens ?? normalizeContextTokens(ctx.providerId, {
        promptTokens: usage.promptTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      })
      // Lightweight UPDATE — bypasses the repository because there's no
      // public-facing API for "patch the latest message". Single-table
      // write, no FK touch.
      await updateMessageUsage(
        db,
        lastAssistantMessageId,
        usage.promptTokens,
        usage.completionTokens,
        costUsd,
        usage.cacheReadTokens ?? 0,
        usage.cacheCreationTokens ?? 0,
        contextTokens,
      )
    },
  }
}

async function updateMessageUsage(
  db: DbClient,
  messageId: string,
  promptTokens: number,
  completionTokens: number,
  costUsd: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  contextTokens: number,
): Promise<void> {
  // Move the increment off the message row (which started at zero in
  // appendMessage) AND propagate the delta onto the parent conversation
  // totals so the list view stays consistent.
  await db.transaction(async (tx) => {
    const { rows } = await tx<{ conversation_id: string }>`
      select conversation_id
      from ai_messages
      where id = ${messageId}
      limit 1
    `
    const conversationId = rows[0]?.conversation_id
    if (!conversationId) return

    await tx`
      update ai_messages
      set prompt_tokens = ${promptTokens},
          completion_tokens = ${completionTokens},
          cost_usd = ${costUsd},
          cache_read_tokens = ${cacheReadTokens},
          cache_creation_tokens = ${cacheCreationTokens}
      where id = ${messageId}
    `

    await tx`
      update ai_conversations
      set prompt_tokens_total = prompt_tokens_total + ${promptTokens},
          completion_tokens_total = completion_tokens_total + ${completionTokens},
          cost_usd_total = cost_usd_total + ${costUsd},
          cache_read_tokens_total = cache_read_tokens_total + ${cacheReadTokens},
          cache_creation_tokens_total = cache_creation_tokens_total + ${cacheCreationTokens},
          context_tokens = ${contextTokens},
          updated_at = current_timestamp
      where id = ${conversationId}
    `
  })
}
