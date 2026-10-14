# Claude Code provider (subscription-backed)

The **Claude Code** provider runs the CMS agent on the machine's logged-in
Claude **subscription** (Pro/Max) instead of a metered Anthropic API key. You
type in the normal AI panel; behind the scenes the driver spawns the headless
`claude` CLI, points it at Instatic's own MCP server, and streams its output
back into the chat — so the agent is real Claude Code (its tool loop, its
harness), editing the live workspace you have open.

This is the inverse of connecting an *external* Claude Code to Instatic over
[MCP connectors](./mcp-connectors.md): here Instatic drives Claude Code, but the
editing still flows through the same live editor bridge.

## Why a CLI subprocess (and not the Agent SDK)

The AI drivers ban every provider **SDK** (`@anthropic-ai/claude-agent-sdk`
included — gated by `ai-driver-isolation.test.ts`) because drivers normally talk
raw provider REST. The Claude Code driver is the deliberate exception: it never
imports an SDK — it **spawns the `claude` binary**, which the gate (import-only)
permits. The subscription cost model only exists in the CLI/subscription auth
path; the Agent SDK bills API credits, so it would defeat the purpose anyway.

## How it works

```
AI panel (Site workspace, open in the browser)
   │  POST /admin/api/ai/chat/site
   ▼
server/ai/handlers/chat.ts → resolveDriver('claude-code')
   ▼
server/ai/drivers/claudeCode.ts   ── Bun.spawn('claude', …)
   │   • ANTHROPIC_API_KEY stripped from the child env  → subscription auth
   │   • ENABLE_TOOL_SEARCH=false in the child env → present every MCP tool up
   │       front. See "Tool visibility" below; without this the turn has no
   │       usable tools at all.
   │   • --tools ""            → strip ALL built-in tools (Bash/Read/Edit/…)
   │   • --allowedTools mcp__instatic  → pre-approve ONLY this server's tools,
   │       so the ~50 mcp__instatic__* tools are directly callable
   │   • --system-prompt <site agent prompt>
   │   • --mcp-config <instatic> --strict-mcp-config
   │   • --dangerously-skip-permissions  (built-ins stripped; ensures MCP
   │       tool calls never block on a permission prompt)
   │   • --session-id/--resume  keyed on the conversation (deterministic UUID)
   ▼
claude CLI  ──MCP (bearer)──▶  /_instatic/mcp
   │                              │  server/ai/mcp/connectors/internalConnector.ts
   │                              │  mints a per-user connector granted the
   │                              │  caller's OWN capabilities (never more)
   ▼                              ▼
stream-json stdout            executeAiTool / live editor bridge
   │                              ▼
translated → AiStreamEvent    the OPEN Site/Content workspace (your live edits)
```

- **Auth:** default (non-`--bare`) CLI mode reads the OAuth/subscription
  credential. `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are removed from the
  child env so the CLI can't fall back to metered billing. `--bare` is never
  used (it forces API-key auth).
- **Credential-less:** the provider needs no secret. To satisfy the existing
  `ai_creds_apikey_shape_check` DB constraint without a migration, the credential
  row is stored as `authMode: 'baseUrl'` with the inert sentinel
  `claude-code://local` (never dialed). See `CLAUDE_CODE_SENTINEL_BASE_URL`.
- **Tool surface:** the CLI sees only the `mcp__instatic__*` tools (the same
  set as `server/ai/mcp/registry.ts`), capability-filtered by the internal
  connector. Browser-execution tools route to the owner's open workspace via the
  MCP editor bridge; headless reads run in-process. Edits stay drafts until an
  explicit `site_publish`.
- **Pricing / context:** billed to the subscription, so `resolveCostUsd` returns
  `0` for `claude-code`; usage is reported in the native Anthropic shape, so it
  normalises like `anthropic` in `contextTokens.ts`.

### Tool visibility (why `ENABLE_TOOL_SEARCH=false`)

`--tools ""` strips every *built-in* tool, which is what keeps Bash/Edit/WebFetch
out of the CMS chat. The CLI's **tool search** (env `ENABLE_TOOL_SEARCH`, default
`auto`) defers a large MCP toolset behind the `ToolSearch` built-in — and that is
a built-in, so `--tools ""` strips it too. With ~50 tools on this server the
default crosses the deferral threshold, and the combination leaves the model with
**zero callable tools**.

A model with no tools does not error: it narrates a tool call in prose
("`get_context` … calling that now") and ends the turn `subtype: "success"`. That
is why the failure looked like the agent simply stopping a few seconds in.

Disabling tool search presents all ~50 tools directly, which is both correct and
faster (~5s to the first tool call, versus ~13-19s through search round trips).

Two independent guards keep this from regressing silently:

- The driver reads the tool list out of the CLI's `system`/`init` event and
  aborts the turn with a clear error if no `mcp__instatic__*` tool is present,
  rather than letting the model bluff. `mcp_servers[].status` distinguishes
  "tool search hid them" from "the MCP server failed to start".
- Each turn logs `[ai/claude-code] session <id> started — N CMS tool(s)`. `N` is
  the number to check first when the agent misbehaves.

### Other failure modes made visible

A subprocess can go quiet in ways an HTTP driver cannot, and all of them look
identical from the composer. Each is terminal and named:

- **Wedged child.** stderr is drained concurrently — an unread pipe blocks the
  writer once full (~64KB) — and an idle watchdog
  (`INSTATIC_CLAUDE_IDLE_TIMEOUT_MS`, default 180s) kills a CLI that stops
  emitting, SIGTERM then SIGKILL.
- **Session mismatch.** `--resume` of a session that isn't on disk, and
  `--session-id` of one that already exists, both exit non-zero. Each retries
  once as the other mode; safe because the failed attempt emitted nothing.
- **Rate limits.** A `rate_limit_event` that isn't `allowed` is surfaced with its
  reset time instead of looking like a stall.
- **Format drift.** Unreadable output lines are counted and logged, so a future
  CLI changing its stream-json shape shows up as a warning rather than silence.

## Setup (bare-metal / dev)

1. Sign in with `claude` on the server host (subscription, not an API key).
2. Ensure the `claude` binary is on the server's PATH, or set
   `INSTATIC_CLAUDE_BIN` to its absolute path.
3. In **AI → Providers**, add the **Claude Code (your subscription)** credential
   (no key needed), then pick it as the Site/Content default or per conversation.

## Setup (Docker / prod)

The base image has no `claude` binary. Build the overlay image and provide a
subscription token as an env var — no home-directory mount required.

1. **Build the image with the CLI** (`Dockerfile.claude-code` overlays the base):
   ```sh
   docker build -t instatic:local .
   docker build -f Dockerfile.claude-code -t instatic-cc:local .
   ```
   The overlay installs the self-contained `claude` binary to `/opt/claude/claude`
   and bakes `INSTATIC_CLAUDE_BIN` pointing at it.

2. **Mint a subscription token on the host** (interactive, one-time):
   ```sh
   claude setup-token       # requires an active Claude subscription
   ```
   This is a long-lived Claude Code OAuth token — it bills the flat-rate
   subscription, spends no metered API credits, and is revocable by re-running
   the command.

3. **Wire it in `.env`** next to the compose files:
   ```sh
   INSTATIC_IMAGE=instatic-cc:local
   CLAUDE_CODE_OAUTH_TOKEN=<token from step 2>
   ```

4. **Run with the overlay compose file** (layer it last):
   ```sh
   docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.claude-code.yml up -d
   ```

Inside the container the driver spawns `claude`, which authenticates via
`CLAUDE_CODE_OAUTH_TOKEN` (the driver strips `ANTHROPIC_API_KEY`/
`ANTHROPIC_AUTH_TOKEN` but preserves this var) and connects to the server's own
MCP endpoint on `127.0.0.1:$PORT` — same-container loopback. Then add the
**Claude Code (your subscription)** credential in **AI → Providers** as above.

## Limitations

- Single-operator / personal use. Driving a subscription programmatically to
  back an app is a grey area of Anthropic's terms; this is intended for the
  operator editing their own site, not multi-tenant serving.
- Subscription rate limits (e.g. Max weekly caps) apply.
- The internal connector token lives in-process and rotates on server restart.
