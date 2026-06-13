/**
 * Phase D — AI Agent: shared message and action types.
 *
 * These types live in core/ (no SDK imports) so they can be imported by
 * both the browser-side AgentPanel and the executor without violating
 * Constraints #283/#286 (no Anthropic SDK in src/).
 *
 * The wire format between the server and browser is NDJSON (newline-delimited
 * JSON). Each line is a `ServerStreamEvent` value, JSON-serialised.
 */

import type { AiToolOutput } from '@core/ai'

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------
//
// Browser-bridged tools return the same canonical `AiToolOutput` shape the
// server-side AI runtime waits on: `{ ok, data?, error? }`.

/**
 * Conversation scope shared by every agent surface. Used in URL paths
 * (`/admin/api/ai/chat/${scope}`, `?scope=${scope}`), the conversation-create
 * body, and the per-scope default lookup. Keep it aligned with
 * `server/ai/runtime/types.ts → ToolScope`.
 */
export type AgentToolScope = 'site' | 'content' | 'data' | 'plugin'

export interface AgentRenderSnapshotPayload {
  breakpointId: string
  /** Set when the capture was scoped to a single node subtree (the `nodeId` arg). */
  nodeId?: string
  label: string
  width: number
  capturedAt: number
  screenshot: AgentScreenshotContext
  layout: AgentLayoutReportContext
}

// ---------------------------------------------------------------------------
// Server → Browser stream events (NDJSON wire format)
//
// The wire shape mirrors `AiStreamEvent` from `server/ai/runtime/types.ts`.
// `toolRequest` asks the browser to run one store-backed tool; `toolCall` and
// `toolResult` mirror the model-visible tool lifecycle; `usage` reports
// per-turn token counts persisted on the conversation row server-side.
// ---------------------------------------------------------------------------

/** A chunk of text from the assistant's message. */
interface TextEvent {
  type: 'text'
  text: string
}

/**
 * Bridge handshake: the server has accepted the request and assigned a bridge
 * id. The browser uses this id when POSTing tool-result responses to
 * `/admin/api/ai/tool-result` so the server can correlate the response with the
 * pending tool waiter inside the driver.
 */
interface BridgeReadyEvent {
  type: 'bridgeReady'
  bridgeId: string
}

/**
 * The server-side driver needs the browser to apply a write tool against
 * the editor store. The browser executes it, then POSTs the result to
 * `/admin/api/ai/tool-result` with `{ bridgeId, requestId, result }`.
 */
interface ToolRequestEvent {
  type: 'toolRequest'
  requestId: string
  toolName: string
  input: unknown
}

/** Stream finished normally. */
interface DoneEvent {
  type: 'done'
}

/** Stream terminated due to a server-side error. */
interface ErrorEvent {
  type: 'error'
  message: string
}

/**
 * The driver has issued a tool call. Status is always 'pending' on this
 * event — a paired `toolResult` lands once the tool completes.
 */
interface ToolCallEvent {
  type: 'toolCall'
  toolCallId: string
  toolName: string
  input: unknown
  status: 'pending'
}

/**
 * A previously-issued tool call has completed. `ok` is the success flag;
 * `error` carries the failure message when ok=false.
 */
interface ToolResultEvent {
  type: 'toolResult'
  toolCallId: string
  toolName: string
  ok: boolean
  error?: string
}

/** Aggregated token usage for the entire turn — emitted just before `done`.
 *  Billing/cost only; the context meter is driven by `ContextEvent`. */
interface UsageEvent {
  type: 'usage'
  promptTokens: number
  completionTokens: number
  costUsd?: number
}

/** Per-round context size — drives the live "context used" meter. Emitted once
 *  per provider round-trip; `contextTokens` is the handler-injected,
 *  provider-normalised input the model held that round (the current context
 *  size). The window half is resolved from the model catalogue client-side. */
interface ContextEvent {
  type: 'context'
  contextTokens: number
}

export type ServerStreamEvent =
  | TextEvent
  | BridgeReadyEvent
  | ToolRequestEvent
  | ToolCallEvent
  | ToolResultEvent
  | UsageEvent
  | ContextEvent
  | DoneEvent
  | ErrorEvent

// ---------------------------------------------------------------------------
// Browser conversation model
// ---------------------------------------------------------------------------

export interface AgentToolCall {
  id: string
  /** SDK tool_use id (`toolu_…`) — correlates UI badges with stream events. */
  externalId?: string
  /** Tool name as Claude saw it (e.g. `mcp__instatic__insertHtml`). */
  actionType: string
  /** Tool input as Claude produced it. */
  params: Record<string, unknown>
  result: AiToolOutput | null
  status: 'pending' | 'success' | 'error'
}

/**
 * Chronological message blocks. Claude's response naturally interleaves text
 * and tool calls — the UI renders them in arrival order so a "text → tool →
 * text" sequence is visually three blocks, not "all text grouped above all
 * tools" (which mis-orders late text in front of earlier tool calls).
 */
type AgentMessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; toolCall: AgentToolCall }

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: AgentMessageBlock[]
  timestamp: number
}

// ---------------------------------------------------------------------------
// Browser → Server request body
// ---------------------------------------------------------------------------

export interface AgentRequestBody {
  /** Per-conversation id; the chat handler loads its credential + history. */
  conversationId: string
  /** The user's new message. */
  prompt: string
  /**
   * Scope-specific snapshot handed to the read tools via
   * `ToolContext.snapshot`. Loose `unknown` here because the body now
   * crosses every scope (site → SiteAgentSnapshot, content → ContentSnapshot,
   * …); each scope's tool handlers cast at the boundary.
   */
  snapshot: unknown
}

export interface AgentLayoutRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AgentLayoutNodeContext {
  nodeId: string
  moduleId?: string
  label?: string
  text: string
  rect: AgentLayoutRect
  visible: boolean
  computed: {
    display: string
    position: string
    overflow: string
    color: string
    backgroundColor: string
    fontSize: string
    lineHeight: string
  }
}

export interface AgentLayoutImageContext {
  nodeId?: string
  src: string
  alt?: string
  complete: boolean
  naturalWidth: number
  naturalHeight: number
  rect: AgentLayoutRect
}

export interface AgentLayoutWarningContext {
  type: 'horizontal-overflow' | 'vertical-overflow' | 'hidden-overflow' | 'broken-image' | 'invisible-node'
  severity: 'info' | 'warning' | 'error'
  message: string
  nodeId?: string
}

export interface AgentLayoutReportContext {
  breakpointId: string
  /** Set when the report was scoped to a single node subtree; coordinates are relative to that node's box. */
  nodeId?: string
  viewport: {
    width: number
    height: number
    scrollWidth: number
    scrollHeight: number
  }
  nodes: AgentLayoutNodeContext[]
  images: AgentLayoutImageContext[]
  warnings: AgentLayoutWarningContext[]
}

export interface AgentScreenshotContext {
  status: 'ok' | 'unavailable' | 'error'
  mimeType?: string
  data?: string
  width?: number
  height?: number
  error?: string
}

// ---------------------------------------------------------------------------
// Slice runtime helpers
//
// Browser-side runtime contracts shared between the agent slice factory
// (agentSlice.ts) and the stream-event processor (streamEvents.ts). Kept here
// so neither module has to import the other just for a type.
// ---------------------------------------------------------------------------

/**
 * Bridge runtime — `bridgeId` is set on the `bridgeReady` event and read on
 * every `toolRequest` so the browser can correlate tool-result POSTs with the
 * server-side pending tool waiter.
 */
export interface AgentBridgeRuntime {
  bridgeId: string | null
}

/**
 * Sink for assistant text deltas. `append` accumulates a delta; `flush`
 * drains accumulated text into the message's blocks immediately. The slice's
 * implementation rAF-batches `append` calls; the toolCall/toolResult handlers
 * call `flush` so any pending text lands BEFORE a tool-call block is appended,
 * preserving chronological order in the UI.
 */
export interface AgentTextStreamSink {
  append(assistantId: string, text: string): void
  flush(): void
}
