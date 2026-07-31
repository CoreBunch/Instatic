/**
 * Agent HTTP layer — the network plumbing behind the agent slice.
 *
 * Responsibilities:
 *   1. Conversation bootstrap: discover the per-scope default credential,
 *      create the conversation row lazily on first send, and rehydrate
 *      persisted message records back into the in-memory `AgentMessage` shape.
 *
 * The agent slice (agentSlice.ts) and the stream-event processor
 * (streamEvents.ts) call into here; this module owns no React/store state.
 */

import { nanoid } from 'nanoid'
import { INTERRUPTED_TOOL_RESULT_ERROR, aiToolError } from '@core/ai'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest, isAbortError } from '@core/http'
import {
  AI_CONVERSATIONS_PATH,
  AI_DEFAULTS_PATH,
} from './agentConfig'
import type { ConversationDetail } from '@admin/ai/api'
import type {
  AgentMessage,
  AgentToolCall,
  AgentToolScope,
} from './types'

// ---------------------------------------------------------------------------
// Conversation bootstrap
//
// On first send we POST to /admin/api/ai/conversations to create a row, then
// reuse its id for every subsequent send in this session. The conversation
// row carries `(credentialId, modelId)`; the chat handler reads them from
// the row.
//
// If no site default exists yet, conversation creation will 400 — the panel
// renders a "no credential configured" banner in that case.
// ---------------------------------------------------------------------------

/**
 * Translate persisted MessageRecord rows back into the in-memory AgentMessage
 * shape (text + toolCall blocks; tool-result messages are folded back into the
 * preceding tool-call block's `result` so the UI renders the same way fresh
 * messages would).
 */
export function rehydrateMessages(
  records: ConversationDetail['messages'],
): AgentMessage[] {
  const out: AgentMessage[] = []
  // Only calls still awaiting a persisted role:tool row remain here. Loading a
  // conversation never resumes its old browser bridge, so anything left after
  // the complete scan is historical interruption, not live work.
  const unanswered = new Map<string, AgentToolCall>()

  const markInterrupted = (toolCall: AgentToolCall): void => {
    toolCall.status = 'error'
    toolCall.result = aiToolError(INTERRUPTED_TOOL_RESULT_ERROR)
    // Tool-result images are session-only and cannot be reconstructed after a
    // reload. Be explicit so malformed future wire data cannot revive one.
    delete toolCall.previewImages
  }
  const finalizeUnanswered = (): void => {
    for (const toolCall of unanswered.values()) markInterrupted(toolCall)
    unanswered.clear()
  }

  for (const rec of records) {
    if (rec.role === 'tool') {
      // Fold the first-class `toolResult` block into the matching tool-call
      // block. `ok` is read directly off the block — never inferred from the
      // emptiness of a text block. Orphan rows are ignored; malformed matching
      // rows terminate the call as interrupted instead of leaving a spinner.
      const toolCallId = rec.toolCallId
      if (toolCallId) {
        const existing = unanswered.get(toolCallId)
        if (existing) {
          const resultBlock = rec.content.find((b) => b.kind === 'toolResult')
          if (resultBlock?.kind === 'toolResult') {
            existing.status = resultBlock.ok ? 'success' : 'error'
            existing.result = {
              ok: resultBlock.ok,
              error: resultBlock.ok ? undefined : resultBlock.error,
            }
          } else {
            markInterrupted(existing)
          }
          unanswered.delete(toolCallId)
        }
      }
      continue
    }

    // A real user turn closes the preceding assistant run. Any result that
    // appears later is stale/orphaned and must not resurrect the historical
    // call as successful; this mirrors provider-history healing on the server.
    if (rec.role === 'user') finalizeUnanswered()

    const msg: AgentMessage = {
      id: rec.id,
      role: rec.role === 'user' ? 'user' : 'assistant',
      blocks: [],
      timestamp: Date.parse(rec.createdAt) || Date.now(),
    }

    for (const block of rec.content) {
      if (block.kind === 'text') {
        msg.blocks.push({ kind: 'text', text: block.text })
      } else if (block.kind === 'toolCall') {
        const duplicate = unanswered.get(block.toolCallId)
        if (duplicate) markInterrupted(duplicate)
        const toolCall: AgentToolCall = {
          id: nanoid(),
          externalId: block.toolCallId,
          actionType: block.toolName,
          params: (block.input && typeof block.input === 'object' && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {}),
          result: null,
          status: 'pending',
        }
        msg.blocks.push({ kind: 'toolCall', toolCall })
        unanswered.set(block.toolCallId, toolCall)
      } else if (rec.role === 'user' && block.kind === 'image') {
        msg.blocks.push({
          kind: 'image',
          mimeType: block.mimeType,
          src: block.url,
        })
      }
    }
    out.push(msg)
  }

  finalizeUnanswered()

  return out
}

const ScopeDefaultEntrySchema = Type.Object({
  credentialId: Type.String(),
  modelId: Type.String(),
})
type ScopeDefaultEntry = Static<typeof ScopeDefaultEntrySchema>

const ScopeDefaultsResponseSchema = Type.Object(
  { defaults: Type.Optional(Type.Record(Type.String(), ScopeDefaultEntrySchema)) },
  { additionalProperties: true },
)

export async function fetchScopeDefault(
  scope: AgentToolScope,
  signal?: AbortSignal,
): Promise<ScopeDefaultEntry | null> {
  // Soft fetch: any failure (no default set, network, bad shape) just means
  // "no preselected credential/model" — the caller falls back to the picker.
  try {
    const body = await apiRequest(AI_DEFAULTS_PATH, {
      schema: ScopeDefaultsResponseSchema,
      signal,
    })
    return body.defaults?.[scope] ?? null
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw err
    console.error(`[AgentSlice] Failed to fetch ${scope} default:`, err)
    return null
  }
}

const CreatedConversationEnvelopeSchema = Type.Object(
  { conversation: Type.Object({ id: Type.String() }) },
  { additionalProperties: true },
)
type CreatedConversation = Static<typeof CreatedConversationEnvelopeSchema>['conversation']

export async function createConversationForScope(
  scope: AgentToolScope,
  credentialId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<CreatedConversation> {
  const body = await apiRequest(AI_CONVERSATIONS_PATH, {
    method: 'POST',
    body: { scope, credentialId, modelId },
    schema: CreatedConversationEnvelopeSchema,
    fallbackMessage: 'Conversation create failed',
    signal,
  })
  return body.conversation
}
