/**
 * POST /admin/api/ai/chat/:scope
 *
 * Opens an NDJSON stream against a chat. Body:
 *   {
 *     conversationId: string,
 *     content:        Array<{ kind: 'text' | 'image', ... }>,
 *     snapshot?:      unknown   // scope-specific per-request context
 *   }
 *
 * The conversation row already carries `(credentialId, modelId)` from when
 * it was created. The handler:
 *   1. Verifies `ai.chat` + ownership of the conversation.
 *   2. Loads + decrypts the credential (rejects if rotated).
 *   3. Resolves the driver for the credential's provider.
 *   4. Builds an `AiStreamRequest` (system prompt + tools + history).
 *      Write tools are filtered out unless the caller has `ai.tools.write`.
 *   5. Persists the user message, then runs `runChat({ ... })`.
 *   6. Streams NDJSON events back as the driver produces them.
 */

import { safeParseValue } from '@core/utils/typeboxHelpers'
import {
  AI_CHAT_MAX_REQUEST_BYTES,
  AiChatRequestBodySchema,
  type AiChatRequestBody,
  type AiContentBlock,
} from '@core/ai'
import {
  RequestBodyTooLargeError,
  badRequest,
  jsonResponse,
  payloadTooLarge,
  readValidatedBody,
} from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { createAuditEvent } from '../../repositories/audit'
import {
  appendMessage,
  listMessagesForConversation,
  readConversationForUser,
  replaceDefaultConversationTitle,
  deriveConversationTitle,
  DEFAULT_CONVERSATION_TITLE,
} from '../conversations/store'
import {
  buildMessageHistory,
  projectUserImagesForModel,
} from '../conversations/history'
import {
  readCredentialForUser,
  resolveCredentialForDriver,
  touchCredentialLastUsed,
} from '../credentials/store'
import { resolveDriver } from '../drivers'
import { resolveModelCapabilities } from '../drivers/modelCapabilities'
import {
  AiImageInputError,
  canonicaliseAiUserContent,
  preflightAiUserContent,
} from '../inputImages'
import { selectToolsForScope } from '../tools'
import {
  buildSiteSystemPrompt,
  SiteAgentSnapshotSchema,
  type SiteAgentSnapshot,
} from '../tools/site'
import {
  buildContentSystemPrompt,
  type ContentSnapshot,
} from '../tools/content'
import {
  createBridge,
  createConversationsPersister,
  encodeStreamEvent,
  runChat,
} from '../runtime'
import { normalizeContextTokens } from '../contextTokens'
import type {
  AiStreamEvent,
  ToolScope,
} from '../runtime/types'
import type { AiStreamRequest } from '../drivers/types'

const VALID_SCOPES: ToolScope[] = ['site', 'content', 'data', 'plugin']
const activeChatConversations = new Set<string>()
const REQUEST_ABORTED = Symbol('request-aborted')

/**
 * Match `/admin/api/ai/chat/:scope`. Returns `null` if path doesn't match.
 */
export function tryHandleAiChat(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (!pathname.startsWith('/admin/api/ai/chat/')) return null
  const scope = pathname.slice('/admin/api/ai/chat/'.length)
  if (!VALID_SCOPES.includes(scope as ToolScope)) return null
  return handleAiChat(req, db, scope as ToolScope)
}

async function handleAiChat(
  req: Request,
  db: DbClient,
  scope: ToolScope,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  // `ai.chat` is the read floor for the conversation endpoint — required
  // for every caller. Write tools are filtered separately below based on
  // the caller's `ai.tools.write` capability so a Client granted chat
  // can use the agent for ideas without it being able to mutate the
  // editor store.
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse
  const user = userOrResponse

  let chatBody: AiChatRequestBody | null
  try {
    chatBody = await readValidatedBody(req, AiChatRequestBodySchema, {
      maxBytes: AI_CHAT_MAX_REQUEST_BYTES,
    })
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return payloadTooLarge('Chat request is too large.')
    }
    throw err
  }
  if (!chatBody) return badRequest('Invalid request body.')
  const { conversationId, content, snapshot } = chatBody

  const conversation = await readConversationForUser(db, user.id, conversationId)
  if (!conversation) {
    return jsonResponse({ error: 'Conversation not found' }, { status: 404 })
  }
  if (conversation.scope !== scope) {
    return jsonResponse(
      { error: `Conversation scope is "${conversation.scope}", not "${scope}".` },
      { status: 400 },
    )
  }
  if (!conversation.credentialId) {
    return jsonResponse(
      { error: 'Conversation has no credential set. Open AI settings to configure a provider.' },
      { status: 400 },
    )
  }

  const credential = await readCredentialForUser(db, user.id, conversation.credentialId)
  if (!credential) {
    return jsonResponse(
      { error: 'Credential not found or no longer accessible.' },
      { status: 404 },
    )
  }
  let resolvedCredential
  try {
    resolvedCredential = await resolveCredentialForDriver(credential)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Credential resolution failed.'
    return jsonResponse({ error: message }, { status: 409 })
  }

  const driver = resolveDriver(credential.providerId)
  let preflight: ReturnType<typeof preflightAiUserContent>
  try {
    preflight = preflightAiUserContent(content)
  } catch (err) {
    if (err instanceof AiImageInputError) {
      return err.status === 413 ? payloadTooLarge(err.message) : badRequest(err.message)
    }
    throw err
  }
  const requestedImage = preflight.images.length > 0

  // Resolve every selected model, not only image-bearing turns: the same
  // authoritative flag also gates browser-tool screenshots. Model-specific
  // drivers are cached/de-duplicated by the shared resolver.
  const modelCapabilities = await waitForRequest(
    resolveModelCapabilities(driver, resolvedCredential, conversation.modelId),
    req.signal,
  )
  if (modelCapabilities === REQUEST_ABORTED) return clientClosedRequest()
  const tools = selectToolsForScope(scope, user.capabilities)
  if (requestedImage && !modelCapabilities.visionInput) {
    return jsonResponse(
      { error: 'The selected model does not support image input. Choose a vision-capable model.' },
      { status: 422 },
    )
  }
  if (tools.length > 0 && !modelCapabilities.toolCalling) {
    return jsonResponse(
      { error: 'The selected model does not support tool calling. Choose an agent-capable model.' },
      { status: 422 },
    )
  }
  if (req.signal.aborted) return clientClosedRequest()

  // One provider stream may write a conversation at a time so concurrent tabs
  // cannot interleave assistant/tool rows. Acquire admission before the
  // expensive Sharp boundary: the retryable loser must not decode eight images
  // only to discover that another request already owns the conversation.
  const releaseConversation = acquireConversationStream(conversation.id)
  if (!releaseConversation) {
    return jsonResponse(
      { error: 'This conversation is already generating a response. Wait for it to finish.' },
      { status: 409 },
    )
  }
  if (req.signal.aborted) {
    releaseConversation()
    return clientClosedRequest()
  }

  // Full decode/re-encode is deliberately after the capability gates so an
  // incompatible selected model cannot force needless Sharp work.
  let userContent: AiContentBlock[]
  try {
    userContent = await canonicaliseAiUserContent(preflight, req.signal)
  } catch (err) {
    releaseConversation()
    if (req.signal.aborted) return clientClosedRequest()
    if (err instanceof AiImageInputError) {
      return err.status === 413 ? payloadTooLarge(err.message) : badRequest(err.message)
    }
    throw err
  }
  if (req.signal.aborted) {
    releaseConversation()
    return clientClosedRequest()
  }

  let existingRecords: Awaited<ReturnType<typeof listMessagesForConversation>>
  let latestConversation: NonNullable<Awaited<ReturnType<typeof readConversationForUser>>>
  try {
    const refreshedConversation = await readConversationForUser(db, user.id, conversation.id)
    if (!refreshedConversation) {
      releaseConversation()
      return jsonResponse({ error: 'Conversation not found' }, { status: 404 })
    }
    latestConversation = refreshedConversation
    if (
      latestConversation.credentialId !== conversation.credentialId
      || latestConversation.modelId !== conversation.modelId
    ) {
      releaseConversation()
      return jsonResponse(
        { error: 'The conversation model changed while this message was being prepared. Send again.' },
        { status: 409 },
      )
    }
    existingRecords = await listMessagesForConversation(db, conversation.id)
  } catch (err) {
    releaseConversation()
    throw err
  }
  if (req.signal.aborted) {
    releaseConversation()
    return clientClosedRequest()
  }
  const prepared = await (async () => {
    try {
      // Append the user's message BEFORE streaming so it's persisted even if
      // the stream aborts mid-response.
      const appendedMessage = await appendMessage(db, conversation.id, {
        role: 'user',
        content: userContent,
      })

      // The first prompt names the conversation: replace the placeholder title
      // with an excerpt of what the user asked for. Only fires while the title
      // is still the default, so a user-renamed chat is never overwritten.
      if (latestConversation.title === DEFAULT_CONVERSATION_TITLE) {
        const text = userContent.find((block) => block.kind === 'text')
        const imageCount = userContent.filter((block) => block.kind === 'image').length
        const derivedTitle = text?.kind === 'text'
          ? deriveConversationTitle(text.text)
          : imageCount === 1 ? 'Image' : 'Images'
        if (derivedTitle) {
          await replaceDefaultConversationTitle(db, user.id, conversation.id, derivedTitle)
            .catch((err) => { console.error('[ai/chat] auto-title failed:', err) })
        }
      }

      const messages = projectUserImagesForModel(
        buildMessageHistory([...existingRecords, appendedMessage]),
        modelCapabilities.visionInput,
      )
      const systemPrompt = buildSystemPromptForScope(scope, snapshot)

      // Capture totals reported by the persister so the audit row can hold
      // them when the stream completes (we read them off the conversation row
      // diff post-stream — see the post-loop block).
      const tokensAtStart = {
        prompt: latestConversation.promptTokensTotal,
        completion: latestConversation.completionTokensTotal,
        cost: latestConversation.costUsdTotal,
      }

      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'ai.chat.started',
        targetType: 'ai_conversation',
        targetId: conversation.id,
        metadata: {
          scope,
          providerId: credential.providerId,
          modelId: conversation.modelId,
        },
      })
      return { messages, systemPrompt, tokensAtStart }
    } catch (err) {
      releaseConversation()
      throw err
    }
  })()
  const { messages, systemPrompt, tokensAtStart } = prepared

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let streamClosed = false
      let destroyBridge: (() => void) | null = null
      let streamError: string | null = null

      const closeStream = () => {
        if (streamClosed) return
        streamClosed = true
        try { controller.close() } catch { /* already closed */ }
      }
      const emit = (event: AiStreamEvent): void => {
        if (streamClosed) return
        if (event.type === 'error') streamError = event.message
        // Inject the live "context used" count onto each per-round `context`
        // event: the provider-normalised input the model held that round.
        // Drivers report raw token buckets; the handler knows the provider, so
        // it normalises here for the composer meter. (The window is resolved
        // client-side from the model catalogue, so it isn't carried on the
        // wire.) `usage` stays billing-only — the meter is driven by `context`.
        const wireEvent: AiStreamEvent =
          event.type === 'context'
            ? { ...event, contextTokens: normalizeContextTokens(credential.providerId, event) }
            : event
        try {
          controller.enqueue(encodeStreamEvent(wireEvent))
        } catch {
          streamClosed = true
        }
      }

      try {
        // Mutable per-turn context. `snapshot` starts at the value the browser
        // posted with the request and is refreshed in place by the bridge's
        // onSnapshot after each mutating browser tool — so a read tool run
        // later in the same turn sees current state, not stale turn-start state.
        const toolContextBase = {
          db,
          userId: user.id,
          capabilities: user.capabilities,
          scope,
          conversationId: conversation.id,
          snapshot,
        }
        const { bridgeId, bridge, destroy } = createBridge(
          emit,
          req.signal,
          undefined,
          (next) => { toolContextBase.snapshot = next },
        )
        destroyBridge = destroy
        emit({ type: 'bridgeReady', bridgeId })

        const request: AiStreamRequest = {
          systemPrompt,
          // Full conversation history — direct HTTP drivers replay it every
          // turn (there is no server-side session to resume).
          messages,
          tools,
          modelId: conversation.modelId,
          modelCapabilities,
          credentials: resolvedCredential,
          signal: req.signal,
          bridge,
          toolContextBase,
        }

        const persister = createConversationsPersister(db, conversation.id, {
          providerId: credential.providerId,
          modelId: conversation.modelId,
        })
        await runChat({ driver, request, persister, emit })

        // Best-effort: record that this credential was used.
        await touchCredentialLastUsed(db, credential.id).catch(() => { /* noop */ })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        // Full Error preserves the stack trace in the operator's terminal.
        console.error('[ai/chat] stream failed:', err)
        streamError = detail
        emit({ type: 'error', message: `AI chat failed: ${detail}` })
      } finally {
        if (destroyBridge) destroyBridge()
        // Emit the terminal audit event. Re-read the conversation row to
        // capture the deltas the persister just committed.
        try {
          const post = await readConversationForUser(db, user.id, conversation.id)
          const promptDelta = post ? post.promptTokensTotal - tokensAtStart.prompt : 0
          const completionDelta = post ? post.completionTokensTotal - tokensAtStart.completion : 0
          const costDelta = post ? Number((post.costUsdTotal - tokensAtStart.cost).toFixed(6)) : 0
          await createAuditEvent(db, {
            actorUserId: user.id,
            action: streamError ? 'ai.chat.failed' : 'ai.chat.completed',
            targetType: 'ai_conversation',
            targetId: conversation.id,
            metadata: {
              scope,
              providerId: credential.providerId,
              modelId: conversation.modelId,
              promptTokens: promptDelta,
              completionTokens: completionDelta,
              costUsd: costDelta,
              ...(streamError ? { error: streamError.slice(0, 200) } : {}),
            },
          })
        } catch (auditErr) {
          // Audit failures must never break the user-visible stream — the
          // request already finished by the time we hit this branch.
          console.error('[ai/chat] audit emit failed:', auditErr)
        } finally {
          releaseConversation()
          closeStream()
        }
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'private, no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function acquireConversationStream(conversationId: string): (() => void) | null {
  if (activeChatConversations.has(conversationId)) return null
  activeChatConversations.add(conversationId)
  let released = false
  return () => {
    if (released) return
    released = true
    activeChatConversations.delete(conversationId)
  }
}

function clientClosedRequest(): Response {
  return new Response(null, { status: 499, statusText: 'Client Closed Request' })
}

function waitForRequest<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof REQUEST_ABORTED> {
  if (signal.aborted) return Promise.resolve(REQUEST_ABORTED)
  return new Promise<T | typeof REQUEST_ABORTED>((resolve, reject) => {
    const onAbort = () => resolve(REQUEST_ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function buildSystemPromptForScope(
  scope: ToolScope,
  snapshot: unknown,
): string[] {
  if (scope === 'site') {
    if (snapshot === undefined || snapshot === null) {
      return buildSiteSystemPrompt(emptySiteAgentSnapshot())
    }
    // The snapshot comes straight off the untyped HTTP body — validate it
    // before handing it to the prompt builder, and fall back to an empty
    // snapshot (rather than crashing the stream) when it's malformed.
    const result = safeParseValue(SiteAgentSnapshotSchema, snapshot)
    if (!result.ok) {
      console.error('[ai/chat] invalid site snapshot, using empty fallback:', result.errors)
      return buildSiteSystemPrompt(emptySiteAgentSnapshot())
    }
    return buildSiteSystemPrompt(result.value)
  }
  if (scope === 'content') {
    return buildContentSystemPrompt((snapshot ?? emptyContentSnapshot()) as ContentSnapshot)
  }
  // Other scopes don't have system prompts yet. The driver gets a minimal
  // prompt so the conversation isn't completely contextless.
  return [
    `You are an AI assistant embedded in the "${scope}" workspace of a CMS. ` +
    `No scope-specific tools are wired up yet — respond conversationally only.`,
  ]
}

function emptySiteAgentSnapshot(): SiteAgentSnapshot {
  return {
    page: {
      id: '',
      title: 'Untitled',
      slug: '',
      rootNodeId: '',
      nodes: {},
    } as SiteAgentSnapshot['page'],
    currentDocument: { type: 'page', id: 'empty' },
    site: {
      pages: [],
      breakpoints: [],
      styleRules: {},
      visualComponents: [],
      settings: { shortcuts: {} },
    } as unknown as SiteAgentSnapshot['site'],
    selectedNodeId: null,
    activeBreakpointId: '',
  }
}

function emptyContentSnapshot(): ContentSnapshot {
  return {
    collections: [],
    activeTableId: null,
    activeDocument: null,
    currentUser: { id: '', displayName: 'Anonymous', email: '' },
  }
}
