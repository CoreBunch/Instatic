/**
 * Claude Code driver — subscription-backed, spawns the local `claude` CLI.
 *
 * Unlike every other driver, this one does NOT talk to a REST API. It spawns
 * the installed `claude` binary in headless mode (`claude -p --output-format
 * stream-json`) authenticated by the machine's logged-in Claude subscription
 * (Pro/Max) — NOT a metered API key. The whole point is to run the CMS agent
 * on the flat-rate Claude Code subscription instead of pay-per-token API usage.
 *
 * How the CLI reaches the CMS tools: the spawned `claude` is pointed at
 * Instatic's OWN MCP server (`/_instatic/mcp`) via `--mcp-config`, using an
 * internal per-user connector bearer token. So Claude Code drives the exact
 * same tool surface the built-in agent panel uses (`server/ai/mcp/registry.ts`),
 * and browser-execution tools route to the user's OPEN Site/Content workspace
 * through the live editor bridge — i.e. it edits the page you're looking at.
 *
 * Auth rules (see `claude --help`):
 *   - Default (non-`--bare`) mode reads the OAuth/keychain subscription creds.
 *   - `--bare` FORCES ANTHROPIC_API_KEY-only auth — never use it here.
 *   - If ANTHROPIC_API_KEY is present in the child env the CLI prefers it
 *     (metered API billing), so the driver STRIPS it from the subprocess env.
 *
 * The SDK-ban gate (`ai-driver-isolation.test.ts`) is import-based only:
 * spawning a binary imports nothing, so this driver is compliant — it never
 * imports `@anthropic-ai/claude-agent-sdk` or any provider SDK.
 *
 * The credential is a sentinel: the Claude Code provider is credential-less
 * (auth is the machine subscription), but a conversation must reference a
 * credential row. We store an `authMode: 'baseUrl'` row whose `baseUrl` is the
 * sentinel `CLAUDE_CODE_SENTINEL_BASE_URL`; the driver ignores it.
 *
 * Three modules, by responsibility:
 *
 *   claudeCode.ts         this file — what to ask the CLI for: the provider
 *                         definition, the argv/env it is invoked with, and the
 *                         session-mode decision.
 *   claudeCodeProcess.ts  how to run it — one spawn, its failure modes, and the
 *                         terminal outcome each produces.
 *   claudeCodeEvents.ts   how to read what came back — stream-json validation
 *                         and translation to `AiStreamEvent`.
 *
 * A subprocess has many more ways to go quiet than an HTTP driver, and every one
 * of them used to look identical from the composer: a few seconds of output,
 * then nothing, forever — no error, no `done`. `claudeCodeProcess.ts` exists to
 * give each of those silences a name; the one cause that lives HERE is the tool
 * surface, because it is decided by the argv/env below:
 *
 *   The CLI defers a large MCP toolset behind its `ToolSearch` built-in, which
 *   `--tools ''` strips — so the model got ZERO callable tools, bluffed a tool
 *   call in prose, and ended the turn `success`. `ENABLE_TOOL_SEARCH=false`
 *   fixes the cause; the `system`/`init` tool count is checked anyway, so a
 *   future CLI that ignores the env var fails loudly instead of bluffing.
 */

import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type AiContentBlock,
  type AiMessage,
  type AiProviderId,
  type AiStreamEvent,
} from '../runtime/types'
import type {
  AiProvider,
  AiProviderCapabilities,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import { getInternalConnectorToken } from '../mcp/connectors/internalConnector'
import { runClaudeAttempt, type SessionMode } from './claudeCodeProcess'

/**
 * Sentinel `base_url` stored on the credential row so it satisfies the existing
 * `ai_creds_apikey_shape_check` DB constraint (the `baseUrl` arm) without a new
 * auth mode or migration. The driver never dials it — auth is the machine's
 * Claude subscription.
 */
export const CLAUDE_CODE_SENTINEL_BASE_URL = 'claude-code://local'

const SUPPORTED_AUTH_MODES = ['baseUrl'] as const

/**
 * Model aliases the `claude` CLI resolves to the latest of each family. Using
 * aliases (not pinned ids) means new model releases surface with no code change
 * — the closest CLI analogue of the other drivers' live `/v1/models` catalogue.
 */
const CLAUDE_CODE_MODELS: AiProviderModel[] = [
  {
    id: 'sonnet',
    label: 'Claude Sonnet (latest)',
    tier: 'balanced',
    capabilities: claudeCodeCapabilities(),
    catalogueSource: 'live',
  },
  {
    id: 'opus',
    label: 'Claude Opus (latest)',
    tier: 'smartest',
    capabilities: claudeCodeCapabilities(),
    catalogueSource: 'live',
  },
  {
    id: 'haiku',
    label: 'Claude Haiku (latest)',
    tier: 'fast',
    capabilities: claudeCodeCapabilities(),
    catalogueSource: 'live',
  },
]

function claudeCodeCapabilities(): AiProviderCapabilities {
  return {
    // Every current Claude model tool-calls and accepts images. Prompt caching
    // is handled internally by the CLI (we don't send cache_control), so we
    // report it off from the driver's perspective.
    toolCalling: true,
    visionInput: true,
    toolResultImages: true,
    promptCache: false,
    streaming: true,
  }
}

export const claudeCodeDriver: AiProvider = {
  id: 'claude-code' as AiProviderId,
  label: 'Claude Code',
  supportedAuthModes: [...SUPPORTED_AUTH_MODES],

  capabilities(_modelId: string) {
    return claudeCodeCapabilities()
  },

  async listModels(_creds: AiResolvedCredential, _signal?: AbortSignal) {
    // Static list — the CLI has no queryable catalogue. Marked `live` so the
    // credential `/test` health check (which requires ≥1 live model) passes.
    return CLAUDE_CODE_MODELS
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    yield* streamClaudeCode(req)
  },
}

// ---------------------------------------------------------------------------
// stream() implementation — spawn the CLI, translate its stream-json output
// ---------------------------------------------------------------------------

/** Absolute path to the `claude` binary; overridable when it isn't on PATH. */
const CLAUDE_BIN = process.env.INSTATIC_CLAUDE_BIN ?? 'claude'

/**
 * Extra orientation appended to Instatic's site system prompt: the CLI drives
 * the CMS through the MCP tools (which it sees under the `mcp__instatic__`
 * prefix), and has no filesystem/shell access here.
 */
const MCP_ORIENTATION =
  'You operate this CMS EXCLUSIVELY through the mcp__instatic__* tools shown to ' +
  'you — you have no filesystem, shell, or web access. Call get_context first to ' +
  'orient yourself in the live workspace. All edits are drafts; only call ' +
  'site_publish when the user explicitly asks to publish.'

async function* streamClaudeCode(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
  const { db, userId, capabilities, conversationId } = req.toolContextBase

  // 1) Internal MCP connector token so the spawned CLI can reach /_instatic/mcp
  //    with exactly this user's capabilities.
  let token: string
  try {
    token = await getInternalConnectorToken(db, userId, capabilities)
  } catch (err) {
    yield { type: 'error', message: `Claude Code: could not provision MCP access — ${errMsg(err)}` }
    return
  }

  const port = process.env.PORT ?? '3001'
  const mcpConfig = JSON.stringify({
    mcpServers: {
      instatic: {
        type: 'http',
        url: `http://127.0.0.1:${port}/_instatic/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  })

  const userText = latestUserText(req.messages)
  if (!userText) {
    yield { type: 'error', message: 'Claude Code: no user prompt to send.' }
    return
  }

  const systemPrompt = `${joinSystemPrompt(req.systemPrompt)}\n\n${MCP_ORIENTATION}`

  // Stable cwd so the CLI's on-disk session (keyed by session id + project)
  // resolves across turns and server restarts; never the repo dir (avoids
  // CLAUDE.md discovery leaking coding-agent context).
  const cwd = join(tmpdir(), 'instatic-claude-code')
  await mkdir(cwd, { recursive: true }).catch(() => { /* best-effort */ })

  // Session continuity: one CLI session per conversation, keyed by a
  // deterministic UUID so a restart still resumes. First user turn starts the
  // session; later turns resume it (the CLI already holds the prior history,
  // so we send only the newest user message).
  const sessionUuid = await conversationSessionUuid(conversationId)
  const userTurns = req.messages.filter((m) => m.role === 'user').length
  const primaryMode: SessionMode = userTurns <= 1 ? 'start' : 'resume'

  const baseCmd = [
    CLAUDE_BIN,
    '-p', userText,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', req.modelId,
    '--system-prompt', systemPrompt,
    // Restrict the CLI to Instatic's MCP toolset ONLY. `--tools ''` strips every
    // built-in (Bash/Edit/WebFetch/ToolSearch/…) and `--allowedTools` pre-approves
    // this server's tools, so the model sees only the ~50 mcp__instatic__* tools
    // and calls them directly — no built-in leakage into the CMS chat, no
    // permission prompts.
    //
    // This ONLY holds with tool search disabled (see ENABLE_TOOL_SEARCH in the
    // child env below). With it on, the CLI defers a large MCP toolset behind the
    // `ToolSearch` built-in — which `--tools ''` strips — leaving the model with
    // zero callable tools. It then narrates a tool call in prose and ends the
    // turn `subtype: "success"`, so nothing surfaced as an error.
    '--tools', '',
    '--allowedTools', 'mcp__instatic',
    '--mcp-config', mcpConfig,
    '--strict-mcp-config', // ignore any other globally-configured MCP servers
    '--dangerously-skip-permissions', // built-ins are stripped; guarantees MCP tools never block on a permission prompt
  ]

  // Strip API-key auth so the CLI uses the machine's Claude SUBSCRIPTION, not
  // metered API billing (the whole point of this provider).
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  // Present every MCP tool up front instead of deferring them behind the
  // `ToolSearch` built-in. The CLI's default (`auto`) defers once a toolset gets
  // large, and this server exposes ~50 tools — comfortably over the threshold.
  // Deferral is incompatible with `--tools ''`: the search tool the model would
  // need is itself a built-in, so stripping built-ins strands every MCP tool
  // behind a door the model cannot open. Disabling it also drops a round trip
  // per turn (measured ~5s vs ~13-19s to the first tool call).
  env.ENABLE_TOOL_SEARCH = 'false'

  let attempt = yield* runClaudeAttempt(baseCmd, primaryMode, sessionUuid, cwd, env, req.signal)

  // The on-disk session and our expectation can disagree: a first turn whose CLI
  // never got to create the session, a `/tmp` wipe, or a re-sent first message.
  // Both cases are recoverable, and retrying is safe only because the failed
  // attempt emitted nothing.
  if (attempt.retryAs) {
    console.warn(
      `[ai/claude-code] session ${attempt.mode} failed (${attempt.retryReason}); retrying as ${attempt.retryAs}.`,
    )
    attempt = yield* runClaudeAttempt(baseCmd, attempt.retryAs, sessionUuid, cwd, env, req.signal)
  }

  if (attempt.error) yield { type: 'error', message: attempt.error }
  // No `done` here — the runner emits it when this generator returns.
}

// ---------------------------------------------------------------------------
// Request → CLI input helpers
// ---------------------------------------------------------------------------

function latestUserText(messages: AiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (m.role === 'user') return textOfBlocks(m.content)
  }
  return ''
}

function textOfBlocks(blocks: AiContentBlock[]): string {
  return blocks
    .map((b) => (b.kind === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * Flatten the canonical `systemPrompt` array (1- or 3-element `[prefix,
 * BOUNDARY, suffix]`) into a single string — the CLI takes one `--system-prompt`.
 */
function joinSystemPrompt(parts: string[]): string {
  return parts.filter((p) => p !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('\n\n')
}

/** Deterministic UUIDv4-shaped session id derived from the conversation id. */
async function conversationSessionUuid(conversationId: string): Promise<string> {
  const data = new TextEncoder().encode(`instatic-claude-code:${conversationId}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 16)
  digest[6] = (digest[6]! & 0x0f) | 0x40 // version 4
  digest[8] = (digest[8]! & 0x3f) | 0x80 // variant 10x
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// stream-json event schema — boundary validation (no `as` on parsed JSON)
