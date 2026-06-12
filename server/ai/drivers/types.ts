/**
 * Driver-facing types — the contract every provider driver implements.
 *
 * The runtime owns the agent loop and the bridge; drivers own one SDK each
 * and one or more `AiAuthMode`s.
 *
 * @see docs/plans/2026-05-26-ai-runtime-rewrite.md → "Drivers"
 */

import type { CoreCapability } from '@core/capabilities'
import type {
  AiAuthMode,
  AiBrowserBridge,
  AiMessage,
  AiProviderId,
  AiStreamEvent,
  AiTool,
} from '../runtime/types'

// ---------------------------------------------------------------------------
// Resolved credential — what a driver receives at call time.
// ---------------------------------------------------------------------------

/**
 * Per-call credential, decrypted and assembled by `server/ai/credentials/store.ts`.
 *
 * Shape varies by auth mode:
 *   - 'apiKey'   → apiKey set, baseUrl === null
 *   - 'baseUrl'  → baseUrl set, apiKey may be set (optional bearer)
 *
 * The shape constraints mirror the `ai_creds_apikey_shape_check` DB-level
 * check, so by the time a CredentialRecord reaches this stage, the runtime
 * trusts the union.
 */
export interface AiResolvedCredential {
  readonly id: string
  readonly providerId: AiProviderId
  readonly authMode: AiAuthMode
  readonly apiKey: string | null
  readonly baseUrl: string | null
}

// ---------------------------------------------------------------------------
// Provider capabilities — drivers report what they support.
// ---------------------------------------------------------------------------

export interface AiProviderCapabilities {
  /** Model supports tool/function calling. False for some Ollama models. */
  readonly toolCalling: boolean
  /** Model accepts image content blocks. */
  readonly visionInput: boolean
  /** Provider supports Anthropic-style cache_control on the static prefix. */
  readonly promptCache: boolean
  /** Provider streams tokens. Currently always true; future non-streaming drivers may set false. */
  readonly streaming: boolean
}

// ---------------------------------------------------------------------------
// Model descriptor — returned by listModels(), shown in the picker UI.
// ---------------------------------------------------------------------------

export interface AiProviderModel {
  readonly id: string
  readonly label: string
  readonly capabilities: AiProviderCapabilities
  /**
   * Hint shown next to the label in the picker (e.g. "fast", "smart",
   * "long-context"). Drivers may omit; UI falls back to model id.
   */
  readonly tier?: string
  /**
   * Per-million-token list prices shown inline in the picker. Sourced from the
   * live OpenRouter catalogue: OpenRouter populates this from its own fetch;
   * Anthropic/OpenAI are enriched by the models handler (their APIs omit it).
   * Omitted when no price is known (e.g. Ollama, or an uncatalogued model).
   */
  readonly pricing?: {
    readonly inputPerMTok: number
    readonly outputPerMTok: number
  }
  /**
   * Max context window (total input+output tokens) for the model, from the same
   * catalogue. Omitted when unknown (Ollama, or an uncatalogued model).
   */
  readonly contextWindow?: number
}

// ---------------------------------------------------------------------------
// Stream request — runner builds this once per turn and hands to driver.stream()
// ---------------------------------------------------------------------------

export interface AiStreamRequest {
  /**
   * System prompt as a 1- or 3-element array. Single string = no caching.
   * Three elements [prefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, suffix]
   * = drivers that support prompt cache (Anthropic) apply `cache_control`
   * to the prefix; others concatenate. See `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`.
   */
  readonly systemPrompt: string[]
  /**
   * The full conversation history, oldest-first. Direct HTTP drivers have no
   * server-side session, so every turn replays the entire log: the driver
   * maps `AiMessage[]` into its provider's native message array.
   */
  readonly messages: AiMessage[]
  readonly tools: AiTool[]
  readonly modelId: string
  /**
   * Capabilities of `modelId`, resolved once by the chat handler via
   * `driver.capabilities(modelId)`. The shared tool loop reads `visionInput`
   * to decide whether the browser should capture a `render_snapshot`
   * screenshot at all — non-vision models get the layout report only.
   */
  readonly modelCapabilities: AiProviderCapabilities
  readonly credentials: AiResolvedCredential
  readonly signal: AbortSignal
  readonly bridge: AiBrowserBridge
  /**
   * Base for the per-call `ToolContext` the driver builds when invoking a
   * server-side tool handler. Carries db + identity + scope + the per-turn
   * snapshot; drivers add `signal` and pass the whole thing to the handler.
   *
   * Threading this through the request avoids the module-level "active
   * snapshot" binding the early drivers used (concurrent chats would race
   * a single global). Drivers receive their own copy per call.
   */
  readonly toolContextBase: ToolContextBase
}

/**
 * Subset of `ToolContext` the chat handler can populate at request time —
 * everything except the per-call `signal`. Drivers compose the final
 * `ToolContext` by spreading this and adding their own signal.
 */
export interface ToolContextBase {
  readonly db: import('../../db/client').DbClient
  readonly userId: string
  /** The caller's capability set — threaded into ToolContext for the re-check gate. */
  readonly capabilities: readonly CoreCapability[]
  readonly scope: import('../runtime/types').ToolScope
  readonly conversationId: string
  /**
   * The scope snapshot for read tools. Mutable across a turn: the browser
   * bridge refreshes it after each mutating tool (via createBridge's
   * onSnapshot) so later server read tools see post-mutation state.
   */
  snapshot: unknown
}

// ---------------------------------------------------------------------------
// Provider interface — every driver implements this.
// ---------------------------------------------------------------------------

export interface AiProvider {
  readonly id: AiProviderId
  readonly label: string
  /**
   * Which credential shapes this provider accepts. Current providers expose
   * exactly one shape, so the admin UI derives it from the provider instead
   * of showing a separate auth-mode picker.
   *
   *   anthropic → ['apiKey']
   *   openai    → ['apiKey']
   *   openrouter → ['apiKey']
   *   ollama    → ['baseUrl']
   */
  readonly supportedAuthModes: readonly AiAuthMode[]

  capabilities(modelId: string): AiProviderCapabilities

  listModels(credentials: AiResolvedCredential): Promise<AiProviderModel[]>

  /**
   * Run one agent turn. Yields canonical AiStreamEvents as the model
   * produces them. When a write tool is required, yields a `toolRequest`
   * and awaits the bridge promise — same mechanic the current
   * implementation uses at `server/handlers/agent/index.ts`.
   *
   * Driver MUST honour `signal`: aborting it stops the underlying SDK
   * stream and rejects any in-flight tool-bridge promises.
   */
  stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent>
}
