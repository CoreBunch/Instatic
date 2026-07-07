/**
 * Agent HTTP layer — the network plumbing behind the agent slice.
 *
 * Two responsibilities:
 *   1. Tool-result bridge: POST the executor's canonical `AiToolOutput` to the
 *      server so the in-flight tool waiter resolves and the driver continues.
 *   2. Conversation bootstrap: discover the per-scope default credential,
 *      create the conversation row lazily on first send, and rehydrate
 *      persisted message records back into the in-memory `AgentMessage` shape.
 *
 * The agent slice (agentSlice.ts) and the stream-event processor
 * (streamEvents.ts) call into here; this module owns no React/store state.
 */

import { nanoid } from 'nanoid'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { ApiError, apiRequest, isAbortError } from '@core/http'
import type { AiToolOutput } from '@core/ai'
import {
  AGENT_TOOL_RESULT_PATH,
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
// Tool-result bridge
// ---------------------------------------------------------------------------

const ToolResultAckSchema = Type.Object({ ok: Type.Boolean() })

export async function postToolResult(
  bridgeId: string,
  requestId: string,
  result: AiToolOutput,
  signal: AbortSignal | null,
  snapshot?: unknown,
): Promise<void> {
  try {
    await apiRequest(AGENT_TOOL_RESULT_PATH, {
      method: 'POST',
      body: {
        bridgeId,
        requestId,
        result,
        // Post the fresh post-mutation snapshot so the server can refresh the
        // turn context — server read tools later in the same turn then see the
        // state this tool just produced. Omit when no snapshot was captured.
        ...(snapshot !== undefined ? { snapshot } : {}),
      },
      signal,
      schema: ToolResultAckSchema,
      fallbackMessage: 'Tool-result POST failed.',
    })
  } catch (err) {
    // 404 means the bridge is gone (stream closed before our POST landed) —
    // expected race during abort. AbortError is the same lifecycle from the
    // fetch side. Anything else is a routing/config issue that would silently
    // leave the agent loop hung server-side.
    if (isAbortError(err)) return
    if (err instanceof ApiError && err.status === 404) return
    console.error('[AgentSlice] Failed to post tool-result:', err)
  }
}

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
  const toolCallIndex = new Map<string, AgentToolCall>() // toolCallId → block

  for (const rec of records) {
    if (rec.role === 'tool' && rec.toolCallId) {
      // Fold the first-class `toolResult` block into the matching tool-call
      // block. `ok` is read directly off the block — never inferred from the
      // emptiness of a text block.
      const existing = toolCallIndex.get(rec.toolCallId)
      if (existing) {
        const resultBlock = rec.content.find((b) => b.kind === 'toolResult')
        if (resultBlock?.kind === 'toolResult') {
          existing.status = resultBlock.ok ? 'success' : 'error'
          existing.result = {
            ok: resultBlock.ok,
            error: resultBlock.ok ? undefined : resultBlock.error,
          }
        }
      }
      continue
    }

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
        const toolCall: AgentToolCall = {
          id: nanoid(),
          externalId: block.toolCallId,
          actionType: block.toolName,
          params: (block.input && typeof block.input === 'object'
            ? (block.input as Record<string, unknown>)
            : {}),
          result: null,
          status: 'pending',
        }
        msg.blocks.push({ kind: 'toolCall', toolCall })
        toolCallIndex.set(block.toolCallId, toolCall)
      } else if (block.kind === 'image') {
        // Pasted image attachments rehydrate as thumbnails in the thread.
        msg.blocks.push({ kind: 'image', mimeType: block.mimeType, data: block.data })
      }
      // image blocks — skip in v1; could render via <img> later.
    }
    out.push(msg)
  }

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

export async function fetchScopeDefault(scope: AgentToolScope): Promise<ScopeDefaultEntry | null> {
  // Soft fetch: any failure (no default set, network, bad shape) just means
  // "no preselected credential/model" — the caller falls back to the picker.
  try {
    const body = await apiRequest(AI_DEFAULTS_PATH, { schema: ScopeDefaultsResponseSchema })
    return body.defaults?.[scope] ?? null
  } catch (err) {
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
): Promise<CreatedConversation> {
  const body = await apiRequest(AI_CONVERSATIONS_PATH, {
    method: 'POST',
    body: { scope, credentialId, modelId },
    schema: CreatedConversationEnvelopeSchema,
    fallbackMessage: 'Conversation create failed',
  })
  return body.conversation
}
