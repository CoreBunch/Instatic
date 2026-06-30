# AI Agent

The AI Agent is a model-powered assistant integrated into the visual editor. The user types a request in the Agent Panel; the agent reads the current page snapshot, plans a sequence of edits, and executes them by calling tools. Structure is written as semantic HTML (`insertHtml` / `replaceNodeHtml`); styling is written as CSS — a `<style>` block and/or `class=` attributes inside the insert, or the dedicated `applyCss` tool for authoring/editing any CSS on its own. There is one CSS path and it accepts every selector; `assignClass` / `removeClass` attach existing classes to nodes.

The agent runs on a provider-agnostic AI runtime (`server/ai/`) that can drive any supported model (Anthropic Claude, OpenAI, OpenRouter, Ollama). Every driver talks directly to its provider's REST API over HTTP/SSE — no provider SDKs. All four share one multi-turn tool loop (`drivers/http/toolLoop.ts`); each supplies only a small `ProviderAdapter` of pure mapping functions. The plain `@anthropic-ai/sdk` (and any provider SDK) is banned repo-wide. Gated by `ai-driver-isolation.test.ts`.

---

## TL;DR

- **Structure via HTML.** `insertHtml` and `replaceNodeHtml` accept semantic HTML strings; the browser executor calls `importHtml` (the same pipeline as the paste-HTML UI) to convert them into first-class, editable `PageNode`s.
- **Styling via CSS.** The agent emits CSS the same way a human pastes it: a `<style>` block and/or `class=` attributes inside the `insertHtml`/`replaceNodeHtml` payload, or the standalone `applyCss` tool. The importer (`cssToStyleRules`) classifies every selector — a bare `.foo {}` rule becomes a reusable Selectors-panel class bound to `class="foo"`; any other selector (`.hero a`, `a:hover`, `nav > li`) becomes an ambient rule; `style=` attributes land on the node's inline styles. There is no structured `classes` parameter — the agent never hand-builds classes node-by-node at insert time. `applyCss` is the single tool for authoring/editing CSS on its own; it **upserts**, so re-applying a selector edits the existing rule (the way descendant/pseudo rules get restyled).
- **35 tools total.** 6 server-side catalog read tools (resolved server-side from the posted snapshot / DB) + 29 browser-bridged tools.
- **Two-endpoint bridge.** `POST /admin/api/ai/chat/site` opens an NDJSON stream. When the model calls a browser-bridged tool, the server emits `toolRequest`; the browser executor reads or mutates the editor store and POSTs the `AiToolOutput` result to `POST /admin/api/ai/tool-result`.
- **Provider-agnostic.** The runtime selects a driver (Anthropic, OpenAI, OpenRouter, Ollama) from the conversation's configured credential.
- **Tool input schemas are a single source of truth** in `@core/ai` (`src/core/ai/toolSchemas.ts`). The server tool registry (`server/ai/tools/site/writeTools.ts`) and the browser executor (`executor.ts` + `tokenRunners.ts`) import the exact same schema objects — a constraint added once is enforced on both sides at build time. Gated by `ai-tool-schema-ssot.test.ts` and `ai-tools-typebox-only.test.ts`.
- **Capabilities.** `ai.chat` required to stream; `ai.tools.write` required for write tools. Gated by `ai-handlers-capability-gated.test.ts`.

---

## Where the code lives

```text
src/core/ai/
├── toolOutput.ts           — AiToolOutput type + AiToolOutputSchema + aiToolOk / aiToolError
├── toolSchemas.ts          — all site write-tool input schemas (single source of truth for both server and browser)
└── index.ts                — barrel re-export (canonical @core/ai import path)

server/ai/
├── handlers/
│   ├── chat.ts             — POST /admin/api/ai/chat/:scope  (NDJSON stream)
│   ├── toolResult.ts       — POST /admin/api/ai/tool-result  (bridge POST)
│   ├── conversations.ts    — CRUD for ai_conversations rows
│   ├── credentials.ts      — CRUD for ai_credentials rows (encrypted secrets + endpoint credentials); auto-seeds defaults on create
│   ├── defaults.ts         — GET/PUT/DELETE /admin/api/ai/defaults (per-scope defaults)
│   ├── models.ts           — list available models per provider; enriches Anthropic/OpenAI with catalogue prices + context windows
│   └── audit.ts            — GET /admin/api/ai/audit (usage rollups for the Audit tab; gated by ai.audit.read)
├── audit/
│   └── store.ts            — getUsageTotals / getUsageByUser / getUsageByScope / getUsageByModel / getUsageByDay (four rollup queries; daily rollup bins into the viewer's local calendar day via localDayKeyFactory)
├── conversations/
│   ├── history.ts          — buildMessageHistory(): reconstruct AiMessage[] from persisted rows; heals interrupted tool calls (synthetic error results for unanswered tool_use blocks)
│   ├── store.ts            — appendMessage / listMessagesForConversation / readConversationForUser
│   └── types.ts            — MessageRecord type
├── pricing/
│   ├── index.ts            — resolveCostUsd / getModelCatalogue (6h in-memory cache, DB fallback)
│   ├── openrouterCatalogue.ts — fetches OpenRouter /api/v1/models; pricingKey() normaliser; ModelCatalogue type
│   └── store.ts            — durable DB cache in ai_model_pricing (prices + context_window column)
├── contextTokens.ts        — normalizeContextTokens(): provider-normalised "context used" for the meter
├── tools/
│   ├── site/
│   │   ├── writeTools.ts      — browser-bridged site tools (TypeBox schemas), including document reads/opening and write mutations
│   │   ├── readTools.ts       — server-side catalog read tools
│   │   ├── render.ts          — catalog derivations (`describeAgentModules`, `describeAgentTokens`, `filterTokenFamily`)
│   │   ├── systemPrompt.ts    — HTML-native static prefix + buildDynamicSuffix
│   │   └── snapshot.ts        — `SiteAgentSnapshotSchema` + `SiteAgentSnapshot` re-export + catalog output types (ModuleInfo, SnapshotTokens, …)
│   └── content/            — content-workspace tools (separate scope)
├── drivers/
│   ├── http/
│   │   ├── sse.ts          — parseSseStream(res): reassemble SSE frames across chunks
│   │   ├── execTool.ts     — executeAiTool(): server-handler vs browser-bridge dispatch; normaliseToolOutput(): wraps raw handler results in the canonical AiToolOutput envelope, validated via TypeBox (not duck-typed)
│   │   ├── toolLoop.ts     — runToolLoop(): provider-agnostic multi-turn loop
│   │   ├── toolArgs.ts     — parseToolArguments(json): shared tool-argument JSON parsing (one copy for all drivers)
│   │   └── errors.ts       — isAbortError / classifyHttpError
│   ├── responses-shared.ts — OpenAI-Responses mapping + SSE translator + adapter factory (openai + openrouter)
│   ├── anthropic.ts        — Anthropic driver: direct POST /v1/messages (no SDK)
│   ├── openai.ts           — OpenAI driver: direct POST /v1/responses (no SDK)
│   ├── openrouter.ts       — OpenRouter driver: direct POST /v1/responses (shared Responses path; live /models; native cost)
│   └── ollama.ts           — Ollama driver: direct POST /v1/chat/completions (no SDK)
└── runtime/
    ├── runner.ts           — runChat(): drives a driver, emits stream events
    ├── persister.ts        — ConversationsPersister: messages + usage to DB; writes contextTokens snapshot
    ├── types.ts            — canonical AiStreamEvent / AiMessage / AiTool / ToolContext
    └── transport.ts        — createBridge() / resolveBridgeToolResult()

src/admin/pages/site/agent/
├── index.ts                — public barrel (all external imports go through here)
├── agentSlice.ts           — scope-agnostic Zustand slice factory (createAgentSlice(config))
├── agentSliceConfig.site.ts— site-editor config: scope, snapshot builder, executor wiring
├── agentConfig.ts          — API path constants (AGENT_TOOL_RESULT_PATH, AI_CONVERSATIONS_PATH, …)
├── agentApi.ts             — HTTP layer: tool-result POST, conversation bootstrap, message rehydration
├── streamEvents.ts         — NDJSON schema (ServerStreamEventSchema) + processStreamEvent reducer
├── siteAgentSnapshot.ts    — `SiteAgentSnapshotSchema` (TypeBox) + derived `SiteAgentSnapshot` type + `buildSiteAgentSnapshot` serializer
├── pageContext.ts          — editor adapter: reads active page + store scalars, calls `buildSiteAgentSnapshot`
├── executor.ts             — browser-side dispatcher: validates + runs write tools; auto-navigates canvas to node's owning document before each write
├── documentTools.ts        — list/read/open document helpers for pages, templates, and visual components
├── tokenRunners.ts         — set_color_tokens / set_font_tokens / set_type_scale / set_spacing_scale runners (split from executor.ts)
├── renderEvidence.ts       — captureAgentRenderSnapshot (render_snapshot tool)
├── storeRef.ts             — setAgentStoreApi / getAgentStoreApi (avoids store ↔ executor cycle)
└── types.ts                — ServerStreamEvent, AgentMessage, AgentRequestBody, …

src/admin/pages/content/agent/
├── agentSliceConfig.content.ts — content-workspace config: scope, snapshot builder, executor wiring
├── contentAgentStore.ts        — standalone per-mount Zustand store (AgentSlice only)
└── contentBridge.ts            — content workspace write-tool executor

src/admin/pages/site/panels/AgentPanel/
├── AgentPanel.tsx          — main panel; resolves active model's contextWindow from the models endpoint
├── ModelPicker.tsx         — credential + model selector used in the input bar
├── ConversationHistory.tsx — history popover (browse, restore, delete past threads)
├── ContextMeter.tsx        — "context used / window" progress indicator (display only)
├── ContextMeter.module.css
├── AgentPanel.module.css
└── index.ts                — barrel export

src/admin/pages/ai/
├── AiPage.tsx              — /admin/ai workspace; three tabs gated by ai.providers.manage + ai.audit.read
├── AiPage.module.css
└── tabs/
    ├── ProvidersTab.tsx    — CRUD for ai_credentials rows (provider-derived API key or endpoint credential shape)
    ├── DefaultsTab.tsx     — per-scope model defaults editor
    ├── AuditTab.tsx        — usage audit view: totals strip, by-model/user/scope tables, daily bar chart
    ├── UsageTablePanel.tsx — shared table scaffolding (title + hint header, numeric-aligned columns, empty row)
    └── usageFormat.ts      — formatNumber / formatCost helpers (plain .ts leaf; importable by tests and components alike)
```

The Agent Panel owns the credential list load for its header, lock-state empty states, and model picker. The header always contains a `ConversationHistory` popover (browse and restore past threads), a "New chat" button (`startNewAgentConversation`), a conditional "Clear conversation" button (visible when `agentMessages.length > 0`), a streaming badge, and an "AI settings" shortcut that routes to `/admin/ai`. The AI settings button is always visible in the header, independent of credential state.

The composer has two distinct lock states, expressed as `lockReason: 'setup' | 'chooseModel' | null`:

- `'setup'` — no credentials exist at all. The message area shows a "Connect an AI provider" empty state with a CTA to `/admin/ai`. The model picker is hidden. The textarea placeholder reads "Add AI credentials to start chatting" and the send button tooltip reads "Add AI credentials first".
- `'chooseModel'` — credentials are loaded but no scope default or explicit pick is active yet (`activeCredentialId` or `activeModelId` is null). The message area shows "Choose a model to get started" with a link to set a default in AI settings. The model picker remains visible so the user can pick inline. The textarea placeholder reads "Choose a model below to start" and the send button tooltip reads "Choose a model first".
- `null` — `Boolean(activeCredentialId && activeModelId)` is true; the composer is fully usable.

While credentials are still loading, `lockReason` stays `null` so the panel does not flash a setup prompt before `loadScopeDefault()` resolves.

When the panel opens, `AgentPanel` calls `loadScopeDefault()` so the model picker immediately shows the configured scope default — no "Default" placeholder, no send-time no-provider surprise. `composerLocked` is gated by `hasActiveProvider` (`Boolean(activeCredentialId && activeModelId)`), meaning a stale "No AI provider configured" error string never locks out the UI once a credential + model is staged; picking a model via `setAgentProvider` clears `agentError` immediately, re-enabling the composer.

The composer area includes a `<ContextMeter>` that shows "context used / window" as a progress bar. `AgentPanel` resolves the active model's `contextWindow` from `GET /admin/api/ai/providers/:id/models?credentialId=…` (the same catalogue-enriched response the picker uses), so the meter appears as soon as a model is selected — before the first turn. The "used" half comes from `agentContextTokens` in the store (see slice state below). The meter is hidden when no context window is known (Ollama, uncatalogued models).

---

## Flow

```text
User types prompt → Agent Panel
    │
    ▼
agentSlice.sendAgentMessage(content)
    │
    ├─→ buildSnapshot()  →  SiteAgentSnapshot  (raw active page + site tree)
    ├─→ ensure conversation row  (lazily created from AI defaults on first call)
    ├─→ POST /admin/api/ai/chat/site  { conversationId, prompt, snapshot }
    │
    ▼
Server: chat.ts
    │
    ├─→ CSRF + requireCapability('ai.chat')
    ├─→ load conversation row  (credentialId, modelId) + full message history
    ├─→ decrypt credential; resolveDriver(credential.providerId)
    ├─→ selectToolsForScope('site', capabilities)
    │     — write tools excluded unless caller has ai.tools.write
    ├─→ buildSiteSystemPrompt(snapshot)  →  [staticPrefix, BOUNDARY, dynamicSuffix]
    ├─→ createBridge(emit)  →  { bridgeId, bridge, destroy }
    ├─→ emit { type: 'bridgeReady', bridgeId }
    └─→ runChat({ driver, request, persister, emit })  — streaming begins
          │  request carries the FULL conversation history as req.messages.
          │  Direct HTTP drivers have no server-side session — every turn
          │  replays the whole log, mapped into the provider's message array.
          │
          ├─→ catalog read tool (e.g. list_documents)
          │     → resolved server-side from snapshot; result returned to model
          │
          ├─→ document read/open tool (read_document / open_document)
          │     → bridge.callBrowser(toolName, input)
          │     → browser reads or opens the target page/template/visual component
          │     → result returned to model
          │
          └─→ browser-bridged mutating tool (e.g. insertHtml)
                → bridge.callBrowser(toolName, input)
                → emit { type: 'toolRequest', requestId, toolName, input }
                → driver loop pauses; awaits tool-result POST

NDJSON stream events (one JSON object + \n per line):
    { type: 'bridgeReady', bridgeId }
    { type: 'text', text: '…' }
    { type: 'toolCall', toolCallId, toolName, input, status: 'pending' }
    { type: 'toolRequest', requestId, toolName, input }    ← browser-bridged tools only
    { type: 'toolResult', toolCallId, toolName, ok, error? }
    { type: 'usage', promptTokens, completionTokens, costUsd?, cacheReadTokens?, cacheCreationTokens? }
    { type: 'context', contextTokens }                     ← per-round meter update
    { type: 'done' }
    { type: 'error', message }                             ← on server error

Browser: processStreamEvent(event) in streamEvents.ts
    │
    ├─→ 'bridgeReady'   → store bridgeId in closure
    ├─→ 'toolRequest'   → executeAgentTool(toolName, input)  (executor.ts)
    │       – TypeBox-validates input
    │       – e.g. runInsertHtml → importHtml(html) → insertImportedNodes(parentId, …)
    │       → POST /admin/api/ai/tool-result { bridgeId, requestId, result }
    │       → server resolves pending waiter → driver sees tool_result → continues
    └─→ 'text' / 'toolCall' / 'toolResult' / 'done'  → update agentSlice.agentMessages
```

The two-endpoint design keeps the **browser as editor-store authority** (browser-bridged tools read or mutate the live Zustand store in the browser) while the **server runs the model** (driver + tool routing live server-side).

---

## The page snapshot

Before each `sendAgentMessage` call, `buildCurrentPageContext(get)` (in `pageContext.ts`) builds a `SiteAgentSnapshot` from the live editor store. `pageContext.ts` reads the active page, current editor document (`page`, `template`, or `visualComponent`), and the two editor-only scalars (`selectedNodeId`, `activeBreakpointId`) off the store and calls `buildSiteAgentSnapshot(activePage, state.site, opts)` (in `siteAgentSnapshot.ts`). The result is the raw authoritative tree — no pre-flattening.

```ts
// SiteAgentSnapshot = Static<typeof SiteAgentSnapshotSchema>
type SiteAgentSnapshot = {
  page: Page           // active page with full nodes map
  currentDocument: AgentDocumentRef
  site: SiteDocument   // breakpoints, styleRules, settings intact; non-active pages emptied
  selectedNodeId: string | null
  activeBreakpointId: string
}
```

Only the active page carries full `nodes`. Non-active pages keep metadata (`id`, `title`, `slug`, `template`) with empty `nodes`, bounding the per-turn payload on multi-page sites. Server-side catalog tools read `site.settings`, document metadata, and the server module registry from this snapshot. Full annotated document reads are browser-backed (`read_document`) so the agent can inspect any page, template, or visual component from the live store without shipping every tree in every turn.

**Server-side validation.** The chat handler validates the incoming snapshot against `SiteAgentSnapshotSchema` via `safeParseValue` (a soft boundary). A malformed or absent snapshot falls back silently to an empty placeholder — the stream continues with `Untitled` page context rather than crashing. `SiteAgentSnapshotSchema` lives in `src/admin/pages/site/agent/siteAgentSnapshot.ts` and is the source of truth for the type; there is no parallel `interface SiteAgentSnapshot`.

**Mid-turn refresh.** The snapshot is rebuilt once per `sendAgentMessage`, but a single turn runs many tool calls, and browser tools mutate the live store *during* the turn. To keep server-side catalog tools (`list_documents`, `list_tokens`, …) from seeing stale turn-start state, the browser re-captures `buildSnapshot()` after **every** browser tool and posts it with the tool result (`postToolResult(..., snapshot)`). The server threads it through `resolveBridgeToolResult(..., snapshot)` → the bridge's `onSnapshot` → `toolContextBase.snapshot` (a mutable per-turn field). Because `executeAiTool` re-reads `toolContextBase` for each call, the next catalog tool sees the state the previous browser tool produced. Without this, a catalog read after a write (e.g. `list_documents` right after `addPage`) returned the document set from the start of the turn.

---

## Server endpoints

### `POST /admin/api/ai/chat/site`

```ts
// Request body
{
  conversationId: string   // ai_conversations row id
  prompt:         string
  snapshot:       SiteAgentSnapshot   // built by buildCurrentPageContext()
}

// Response: NDJSON stream of ServerStreamEvent (one JSON line + '\n' each)
```

The handler (`server/ai/handlers/chat.ts`):
1. CSRF-checks and requires `ai.chat`.
2. Loads the conversation row (credentialId, modelId) and the full persisted message history (`listMessagesForConversation` → `buildMessageHistory` → `AiMessage[]`).
3. Decrypts the credential and resolves the driver.
4. Calls `selectToolsForScope('site', capabilities)` — write tools excluded without `ai.tools.write`.
5. Builds the system prompt via `buildSiteSystemPrompt(snapshot)`.
6. Creates a bridge (`createBridge(emit, req.signal)`), emits `bridgeReady`.
7. Calls `runChat(...)` with the full history as `req.messages`. Direct HTTP drivers have no server-side session, so each driver maps the whole `AiMessage[]` log into the provider's native message array every turn (the Anthropic driver pairs assistant `tool_use` blocks with their following `tool_result` turns). The runner pipes all stream events to the HTTP response. Before recording a terminal usage event, the runner flushes any pending assistant text so text-only replies have an assistant message row for per-turn usage and audit rollups. The multi-turn agentic loop lives in `drivers/http/toolLoop.ts`, not in a provider SDK.
8. Emits a terminal `ai.chat.completed` / `ai.chat.failed` audit event.

### `GET /admin/api/ai/audit?since=ISO&tz=IANA`

Returns four rollups consumed by the `/admin/ai` Audit tab and the dashboard "AI usage this month" widget. Gated by `ai.audit.read`.

```ts
// Query params
since?: string   // ISO 8601 start of window; defaults to 30 days ago
tz?:    string   // IANA timezone (e.g. "Europe/Bratislava"); defaults to UTC

// Response
{
  since:   string           // resolved ISO start instant
  totals:  UsageRow         // aggregate totals across the window
  byUser:  UsageByUserRow[] // one row per user_id, sorted by cost desc
  byScope: UsageByScopeRow[]// one row per chat scope ('site' | 'content' | …)
  byModel: UsageByModelRow[]// one row per (provider, model) pair
  byDay:   UsageByDayRow[]  // one row per calendar day in the viewer's timezone
}
```

`byDay` is the time-series chart data — each `day` field is `YYYY-MM-DD` in the viewer's local timezone (not UTC). The daily rollup pulls raw message rows and bins them in JS via `localDayKeyFactory(timeZone)` (`server/time.ts`) rather than SQL date-truncation, because the day boundary depends on the viewer's timezone which the database doesn't know. The client (see `AuditTab.tsx` → `listAiAudit`) reads `Intl.DateTimeFormat().resolvedOptions().timeZone` and passes it as `?tz=`.

The Audit tab (`src/admin/pages/ai/tabs/AuditTab.tsx`) consumes this endpoint. The daily rollup there also aligns its "Today" range window to local midnight (`setHours(0, 0, 0, 0)`) so the day boundary is consistent both in the filter and in the bar chart. The by-model, by-user, and by-scope rollups all render through `UsageTablePanel` (`tabs/UsageTablePanel.tsx`) — a shared table component that takes a `columns` config and handles the empty-state row. Number and cost formatting (`formatNumber`, `formatCost`) live in `tabs/usageFormat.ts`, a plain `.ts` leaf that both the tab components and their tests can import without triggering React Fast Refresh's components-only export rule on the component file.

### `POST /admin/api/ai/tool-result`

```ts
// Request body
{
  bridgeId:  string
  requestId: string
  result:    AiToolOutput   // { ok: boolean; data?: unknown; error?: string; images?: { mimeType, data }[] } — from src/core/ai/
  snapshot?: unknown        // optional post-mutation scope snapshot (see "Mid-turn refresh")
}
```

Requires `ai.tools.write`. Calls `resolveBridgeToolResult(bridgeId, requestId, result, snapshot)` which (when a snapshot is present) refreshes `toolContextBase.snapshot` via the bridge's `onSnapshot`, then resolves the pending tool waiter inside the driver loop so streaming continues. If the bridge is gone (stream already closed), returns 404 and the result is silently dropped.

`AiToolOutput` is the canonical result type shared by both sides of the bridge. Constructors: `aiToolOk(data?, images?)` and `aiToolError(message)` from `@core/ai`. The optional `images` channel carries base64 attachments (e.g. a `render_snapshot` PNG) that drivers forward as native image blocks or drop with a note — see "Heavy evidence" below.

---

## Tools

### Catalog read tools — 6, server-side

Resolved server-side from the posted `SiteAgentSnapshot` or the data repositories via `ctx.db`. No browser round-trip. Results are returned directly to the model. Full annotated HTML reads are browser-backed because the live browser store owns every page/template/visual-component tree.

| Tool              | What it returns                                                         |
|-------------------|-------------------------------------------------------------------------|
| `list_documents`  | Editable document refs for pages, templates, and visual components. Each item includes `{ document: { type, id }, title, rootNodeId, active, current, summary, template? }`; pass those refs to `read_document` / `open_document` |
| `list_modules`    | Module registry (id, name, category, props schema, defaults); `category` filter |
| `list_breakpoints`| Configured breakpoints + active id                                      |
| `list_post_types` | Routable collections eligible as a `postTypes` template target — `{ slug, label, routeBase, kind }` per entry, filtered to a non-empty `routeBase`. Queries the data repositories via `ctx.db` |
| `list_loop_sources` | Loop source ids, source fields, order/filter options, and data-table field catalogs with valid `{currentEntry.field}` tokens. For post/custom table loops, use source id `data.rows`, the returned table `id` as `<instatic-loop data-table-id>`, and the returned tokens inside the loop body |
| `list_tokens`     | Design tokens: colors (with shades/tints), typography/spacing scale steps, font tokens — each with CSS variable + utility classes; optional `family` filter (`colors`\|`typography`\|`spacing`\|`fonts`) |

### Browser tools — 29, browser-bridged

All 29 tools carry `execution: 'browser'` in their `AiTool` definition. The server emits `toolRequest`; the browser executor validates input with TypeBox, runs the store action or read helper, and POSTs the canonical `AiToolOutput` result back.

**Documents**

| Tool              | Input                                  | Success `data`                        | What it does                                           |
|-------------------|----------------------------------------|---------------------------------------|--------------------------------------------------------|
| `read_document`   | `{ document?: { type, id }, part? }`   | `{ document, title, html, css, pageInfo }` | Read a page/template/visual-component document as annotated HTML (`uid="<nodeId>"`) plus compact CSS without switching the visible canvas. Omit `document` to read the current editor document. Result is size-budgeted; call again with `part: pageInfo.nextPart` until `nextPart` is `null` |
| `open_document`   | `{ document: { type, id } }`           | `{ document }`                        | Visibly switch the editor to a page/template/visual component. Use before `render_snapshot` when the target is not current |

**Structure (HTML-native)**

| Tool              | Input                                  | Success `data`                        | What it does                                           |
|-------------------|----------------------------------------|---------------------------------------|--------------------------------------------------------|
| `insertHtml`      | `{ parentId, index?, html }`           | `{ nodeIds }` or `{ cssRulesCreated, cssRulesUpdated }` | Parse HTML (+ any `<style>` CSS) → import as `PageNode`s under `parentId`. Custom `<instatic-loop>` elements import as real Loop nodes; `<instatic-outlet>` imports as a template outlet. A `<style>`-only payload (no elements) upserts CSS rules without inserting nodes (prefer `applyCss` for that) |
| `getNodeHtml`     | `{ nodeId }`                           | `{ html }`                            | Render subtree to HTML via the publisher's `renderNode`|
| `replaceNodeHtml` | `{ nodeId, html }`                     | `{ nodeIds }` or `{ cssRulesCreated, cssRulesUpdated }` | Delete existing children; re-import HTML under the same parent. A `<style>`-only payload upserts CSS rules WITHOUT touching the children |

Styling rides on the `html` payload — there is no separate `classes` parameter. The executor runs `importHtml(html)`, which harvests any `<style>` block's CSS, then hands it to `cssToStyleRules`. That classifier routes each selector:

- a bare `.foo {}` rule → a reusable Selectors-panel **class**, bound to every `class="foo"` node in the fragment;
- any other selector (`.hero a`, `a:hover`, `nav > li`, `@media …`) → an **ambient** rule (media queries fold into the matching breakpoint's `contextStyles`);
- supported stylesheet-level rules such as `@keyframes` → ambient raw CSS rules emitted by the publisher;
- inline `style="…"` attributes → the node's inline styles.

`insertImportedNodes` then links every `class=` token on the imported nodes to its registry class id in the same undo step, so `class="hero-section"` renders and is styleable whether its styles came from a `<style>` rule or an automatically-created bare class. See [html-import.md → Class linking](html-import.md#class-linking-name--id).

**Authoring CSS with `applyCss`.** `applyCss({ css })` is the single tool for CSS that isn't attached to inserted structure. The agent passes real CSS text (e.g. `".hero a:hover { color: var(--primary) }"`); it runs through the same `cssToStyleRules` classifier and is **upserted** into the registry by `upsertCssRules`: a bare `.foo {}` selector creates or edits a reusable class, any other selector (`.hero a`, `a:hover`, `nav > li`, `::before`, `h1`) creates or edits an ambient rule, `@media` folds into per-breakpoint/condition overrides, and supported `@keyframes` become ambient raw CSS rules. Re-applying a selector **merges** onto the existing rule — so the same tool both creates new styles and restyles existing descendant/pseudo rules (the case the retired `updateClassStyles` could not express). Returns `{ cssRulesCreated, cssRulesUpdated }`. Framework-generated token/utility classes are never overwritten. `insertHtml`/`replaceNodeHtml` also accept a `<style>`-only payload and route it through the same upsert as a forgiving fallback, but `applyCss` is the canonical path.

Note the deliberate split: `applyCss` and `<style>`-only payloads **upsert** (the agent's intent is to author/edit CSS), whereas a `<style>` block that accompanies *elements* in an insert is **additive** (`mergeImportedStyleRules` — it never clobbers a shared class as a side effect of dropping in structure).

**Loops through HTML.** A repeated list is authored with the custom importer marker:

```html
<instatic-loop data-source-id="data.rows" data-table-id="<table id>" data-order-by="publishedAt" data-direction="desc" data-limit="3">
  <article>
    <a href="{currentEntry.permalink}">
      <img src="{currentEntry.featuredMedia}">
      <h3>{currentEntry.title}</h3>
    </a>
  </article>
</instatic-loop>
```

The agent calls `list_loop_sources` first to get the valid source id, data table id, order options, and field tokens. The token grammar is single-brace `{currentEntry.field}`; aliases such as `{{post.title}}` are invalid and should never be generated.

**Node edits**

| Tool              | Input                                      | Success `data`          | What it does                                               |
|-------------------|--------------------------------------------|-------------------------|------------------------------------------------------------|
| `updateNodeProps` | `{ nodeId, breakpointId?, patch }`         | none                    | Shallow-merge props; `breakpointId` requires schema `breakpointOverridable: true` |
| `moveNode`        | `{ nodeId, newParentId, newIndex }`        | none                    | Re-parent or reorder; `newIndex` is 0-based               |
| `deleteNode`      | `{ nodeId }`                               | none                    | Remove node and all descendants                            |
| `duplicateNode`   | `{ nodeId, count? }`                       | `{ nodeId, nodeIds }`   | Clone subtree 1–50 times right after the source           |
| `renameNode`      | `{ nodeId, label }`                        | none                    | Set the node's display label in the DOM panel (editor-only)|

**CSS + class assignment**

| Tool          | Input                 | Success `data`                          | What it does                                          |
|---------------|-----------------------|-----------------------------------------|-------------------------------------------------------|
| `applyCss`    | `{ css }`             | `{ cssRulesCreated, cssRulesUpdated }`  | Parse CSS text and upsert every rule — classes (bare `.foo`) and ambient rules (any other selector); re-applying a selector edits it |
| `assignClass` | `{ nodeId, classId }` | none                                    | Attach an existing class to a node; `classId` accepts id or name|
| `removeClass` | `{ nodeId, classId }` | none                                    | Detach a class from a node (the class itself remains) |

**Code assets**

Scripts and user stylesheets live in `site.files[]`; runtime targeting and loading options live in `site.runtime.scripts` / `site.runtime.styles`. These tools expose that existing Code Editor storage to the agent, so behavior such as theme toggles, tabs, menus, filters, and DOM-ready interactions is authored as a real runtime script instead of attempted through HTML import.

| Tool                   | Input                                      | Success `data`                          | What it does                                          |
|------------------------|--------------------------------------------|-----------------------------------------|-------------------------------------------------------|
| `list_code_assets`     | `{ type?: 'script' \| 'style' }`           | `{ assets }`                            | List runtime code assets with file ids, paths, full-content hashes, sizes, timestamps, and runtime config |
| `read_code_asset`      | `{ fileId? \| path?, part?, maxChars? }`   | `{ fileId, path, type, content, hash, runtime, pageInfo }` | Read an exact script/stylesheet content slice. The `hash` is for the full file; page through with `pageInfo.nextPart` |
| `write_code_asset`     | `{ path, type, content, runtime? }`        | asset summary + `{ action }`            | Create or replace a runtime script/stylesheet and normalize its runtime config. Existing paths are updated, new paths are created |
| `patch_code_asset`     | `{ fileId? \| path?, expectedHash, replacements }` | asset summary + `{ replacements }` | Apply exact text replacements only when `expectedHash` matches the latest content. Ambiguous matches require a wider `oldText` or explicit `replaceAll:true` |
| `inspect_code_runtime` | `{ document?: { type, id } }`              | `{ pageId, document, scripts, styles }` | Report which runtime scripts/stylesheets apply to the current page/template or supplied page/template document ref |

`insertHtml` / `replaceNodeHtml` intentionally strip `<script>` elements and inline event handlers (`onclick`, `onload`, etc.). When a request needs behavior, the agent should use `write_code_asset({ type: "script", ... })` and then `inspect_code_runtime`, not raw `<script>` tags or event attributes in HTML.

**Pages**

| Tool            | Input                             | Success `data` | What it does                                               |
|-----------------|-----------------------------------|----------------|------------------------------------------------------------|
| `addPage`       | `{ title, slug? }`                | `{ pageId, rootNodeId }` | Create an empty page and make it active. Slug is auto-uniqued. Build into it via `insertHtml({ parentId: rootNodeId, … })` |
| `deletePage`    | `{ pageId }`                      | none           | Delete page; fails if it would leave the site with 0 pages |
| `renamePage`    | `{ pageId, title, slug? }`        | none           | Change title/slug; `slug="index"` makes this the homepage  |
| `duplicatePage` | `{ pageId, title, slug? }`        | `{ pageId }`   | Deep-clone page (all nodes, props, class assignments)      |

**Templates (CMS layouts)**

A template is a page carrying a `target` plus a single `<instatic-outlet>` where matched content flows in. These bridge to the editor's `convertPageToTemplate` / `convertTemplateToPage` store actions. The outlet itself is placed via `insertHtml` — the importer maps the custom `<instatic-outlet>` element to a `base.outlet` node (see [html-import.md](html-import.md) and [templates.md](templates.md)). No save-time outlet guard: a template with no outlet simply doesn't apply at render time.

| Tool                | Input                                                                 | Success `data` | What it does                                              |
|---------------------|----------------------------------------------------------------------|----------------|----------------------------------------------------------|
| `setPageTemplate`   | `{ pageId, target: {kind:'everywhere'} \| {kind:'postTypes', tableSlugs:[…]}, priority? }` | none | Convert a page to a template (or update its target/priority). `priority` defaults to 100. Get post-type slugs from `list_post_types` |
| `clearPageTemplate` | `{ pageId }`                                                         | none           | Revert a template to an ordinary page (drops target + dynamic bindings); errors if the page is not a template |

**Design system (tokens)**

The agent works **design-system-first**: it establishes or reuses tokens, then references them (`var(--<slug>)`, `--text-*`, `--space-*`, `var(--<font-var>)`) instead of hardcoding hex/px/font-family. Colors and fonts are list-shaped (one entry per token); typography and spacing are scale-shaped (a group config from which the framework generates per-step values). All four are **create-or-update** — keyed by color `slug`, font `variable`, or scale group — so re-runs patch in place. The executor dispatches to the framework/font store actions (`createFrameworkColorToken`, `create/updateFrameworkTypographyGroup`, `create/updateFrameworkSpacingGroup`, `addFont`/`createFontToken`).

| Tool                | Input                                                                 | Success `data`                              | What it does                                          |
|---------------------|----------------------------------------------------------------------|---------------------------------------------|-------------------------------------------------------|
| `set_color_tokens`  | `{ tokens: [{ slug, lightValue, category?, darkValue?, darkModeEnabled? }] }` | `{ tokens: [{ slug, ref, action }] }` | Create/update color tokens → `var(--<slug>)` + utilities/variants |
| `set_font_tokens`   | `{ tokens: [{ name, variable?, fallback?, googleFamily?, variants?, subsets?, familyId? }] }` | `{ tokens: [{ name, variable, ref, installed?, action }] }` | Create/update font tokens. `googleFamily` installs a new web font via `POST /admin/api/cms/fonts/install` then binds the token; `familyId` references an already-installed family; neither = fallback-only. Prefer exactly one of `googleFamily`/`familyId`; if both are sent, `googleFamily` wins and the stale `familyId` is ignored |
| `set_type_scale`    | `{ groupId?, namingConvention?, steps?, baseScaleIndex?, min?: { fontSize?, scaleRatio? }, max?: {…} }` | `{ groupId, action, namingConvention, generatedVars }` | Configure the typography scale → `--text-*`. Creates the group if none exists, else updates it |
| `set_spacing_scale` | `{ groupId?, namingConvention?, steps?, baseScaleIndex?, min?: { size?, scaleRatio? }, max?: {…} }` | `{ groupId, action, namingConvention, generatedVars }` | Configure the spacing scale → `--space-*`. Same shape as `set_type_scale` but `min`/`max` carry `size` |

**Capture**

| Tool              | Input                 | Success `data` | What it does                                                     |
|-------------------|-----------------------|----------------|------------------------------------------------------------------|
| `render_snapshot` | `{ breakpointId?, nodeId? }`   | `{ breakpointId, nodeId?, label, width, capturedAt, layout, screenshot }` + optional `images[]` | Inspect the rendered canvas: always returns a layout report (viewport, per-node bounding boxes, overflow / broken-image / invisible warnings); on a vision-capable model a PNG is attached via the tool-output **image channel**. `breakpointId` picks the frame (defaults to active); `nodeId` scopes the capture to that node's subtree — image and report cover only that section, with coordinates relative to its box, and the report carries the same `nodeId`. Omit `nodeId` for the whole page; an unknown `nodeId` returns an `aiToolError` |

### Auto-navigation

When a node-targeting write tool (`insertHtml`, `getNodeHtml`, `replaceNodeHtml`, `deleteNode`, `updateNodeProps`, `moveNode`, `renameNode`, `duplicateNode`, `assignClass`, `removeClass`) receives a node id that belongs to a different document (another page, a template, or a VC), the executor automatically navigates the canvas to that document **before** running the mutation. This is done via `focusNodeDocument` in `executor.ts`, which calls `store.openPageInCanvas` or `store.setActiveDocument` as appropriate. The effect: the edit lands in the correct tree, stays visible to the user, and the mid-turn snapshot refresh picks up the navigated state for any subsequent read tool in the same turn.

`render_snapshot`, catalog tools (`list_documents`, etc.), and token tools have no node target — they are excluded from auto-navigation.

### Heavy evidence — image channel + vision gating + elision

`render_snapshot` (and `read_document` / `getNodeHtml`) return large payloads. Five rules keep them from exploding context (a screenshot inlined as base64 JSON text once pushed a single turn past 1M tokens):

1. **Image channel, not text.** `AiToolOutput` carries an optional `images: { mimeType, data }[]` (`src/core/ai/toolOutput.ts`). `render_snapshot` puts the PNG there — never in `data`. The Anthropic driver forwards it as a **native `image` block** inside the `tool_result` (billed at the rendered image's token cost). Text-only tool channels (Ollama / OpenAI-compatible `function_call_output`) **drop** the image and append a one-line `[N screenshot(s) omitted…]` note. The capture caps the screenshot's long edge at `MAX_IMAGE_EDGE` (1568px in `renderEvidence.ts`) — a tall landing page would otherwise exceed Anthropic's hard 8000px-per-dimension limit (400 error), and the model downsizes the long edge to ~1568px anyway.
2. **Capture is vision-gated.** The chat handler resolves `driver.capabilities(modelId)` into `AiStreamRequest.modelCapabilities`. The shared tool loop injects `captureScreenshot: visionInput` into every `render_snapshot` call, so a non-vision model never pays the html-to-image cost — it gets the layout report only. (The model never sets `captureScreenshot` itself.)
3. **`read_document` CSS is document-relevant, not the public full-site CSS bundle.** Public pages can share page-invariant CSS files, but `read_document` inlines CSS into model context. It keeps framework variables/utilities, font token variables, target-document module CSS, used class rules, ambient selectors whose class tokens all exist on the target document, classless/global ambient selectors, and document-targeted user stylesheets. It omits browser-only `@font-face` file declarations and ambient selectors from unrelated imported pages.
4. **`read_document` is cleaned and paged before it reaches the model.** `renderAgentDocument` strips pathological strings from the broad read surface: long base64/data URLs become `data:<mime>;base64,[omitted N chars]`, and very long URLs are middle-truncated. The returned object always includes `pageInfo` with `part`, `totalParts`, `nextPart`, `ranges`, `serializedChars`, and cleanup counts. The hard budget is measured against `JSON.stringify({ html, css, pageInfo }).length`, because that is the text providers receive as the tool result. If `nextPart` is not `null`, the agent calls `read_document({ document, part: nextPart })` to continue. For exact node-level markup, use the `uid` with `getNodeHtml`.
5. **Stale evidence is elided.** Within one tool loop, only the **most recent** heavy result per tool name (`render_snapshot`, `read_document`, `getNodeHtml`, or anything with an image) is replayed at full fidelity; earlier ones are rewritten to a one-line breadcrumb (`"Earlier <tool> output removed… Call <tool> again…"`). Older snapshots describe page state the model has since mutated, so they carry no value. See `applyHeavyElision` in `server/ai/drivers/http/toolLoop.ts`.

---

## System prompt

`server/ai/tools/site/systemPrompt.ts` builds a 3-element array:
```ts
[staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix]
```
Drivers that support explicit prompt-cache controls (Anthropic) apply `cache_control` to the static prefix automatically. OpenAI concatenates the prompt parts and sends a stable `prompt_cache_key` derived from the scope + toolset so repeated prefixes route more consistently. Other drivers concatenate the three strings. Content is intentionally static across providers — every observable behaviour comes from the tool definitions, not prompt knobs.

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is the literal `'__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'`, declared **once** in `server/ai/runtime/types.ts` and imported everywhere — prompt builders and every driver. A duplicate definition would silently break prompt caching on whichever driver drifted. Gated by `ai-driver-shared-helpers.test.ts`.

**Static prefix** (full text in `server/ai/tools/site/systemPrompt.ts`):
- **Design system first.** Establish or reuse tokens before/while building (`set_color_tokens`, `set_type_scale`, `set_spacing_scale`, `set_font_tokens`), then reference them in CSS (`var(--<slug>)`, `var(--text-l)`, `var(--space-m)`, `var(--<font-var>)`) instead of raw hex/px/font-family. The dynamic suffix's `Tokens —` line shows what already exists; `(none …)` means no design system yet.
- Structure as HTML (`insertHtml` / `replaceNodeHtml`); style with CSS in the same payload — a `<style>` block and/or `class=` attributes referencing the design tokens. The importer classifies selectors, so the agent never hand-builds classes at insert time.
- `<style>` blocks inside imported HTML are parsed: a bare `.foo {}` rule becomes a Selectors-panel class bound to `class="foo"`; any other selector (`.hero a`, `a:hover`, `@media …`) becomes an ambient rule, and supported `@keyframes` publish as raw keyframes CSS. `style=` attributes land on the node's inline styles. These are applied — not stripped.
- One `insertHtml` call per logical section (nav, hero, pricing, footer = 4–6 calls); smaller chunks recover better if one fails.
- Per-breakpoint variation: `@media` queries — in the `<style>` block of an insert or inside `applyCss` — with min/max-width queries that line up with the breakpoint widths in the dynamic suffix. Never invent ids like `"mobile"` or `"desktop"`.
- Document refs come from the dynamic suffix or `list_documents`; never invent them. Shared chrome/layout/theme/navigation/footer requests should inspect template documents first.
- Page ids for page operations come from the dynamic suffix; never invent them.
- Write-tool success data uses explicit keys: `cssRulesCreated`/`cssRulesUpdated` for `applyCss`, `pageId` for `addPage`/`duplicatePage`, `nodeId`/`nodeIds` for `duplicateNode`, `nodeIds` for HTML inserts.
- Editing existing content: call `read_document` first — it returns annotated document HTML where every element carries `uid="<nodeId>"` plus `pageInfo`; follow `pageInfo.nextPart` when more of the document is needed. Pass `uid` verbatim to write tools (`updateNodeProps`, `replaceNodeHtml`, etc.). For a single subtree, `getNodeHtml` is sufficient.
- Reply rule: 1–2 narrating sentences only. No raw HTML/CSS/JSON in the reply.

**Dynamic suffix** (built per request by `buildDynamicSuffix(snap: SiteAgentSnapshot)`):
```text
Page: "My Site" · root: <rootNodeId> · selected: <nodeId|none>
· active breakpoint: <id> · all breakpoints: [<id>@<width>px, …]
· Documents: [page:<id>="Home" (current, active-page, root=<rootNodeId>; Homepage), template:<id>="Chrome" (root=<rootNodeId>; Everywhere template wrapping all pages), …]
· Pages: [<id>=<slug> (active), <id>=<slug>, …]
· Tokens — colors: [primary=…, ink=…]; type --text-*: [xs, s, m, …]; spacing --space-*: […]; fonts: [--font-heading→Inter]
```
The static prefix is cache-friendly (unchanged across prompts for the same provider). Anthropic marks only that prefix with `cache_control`; OpenAI relies on automatic prefix caching plus `prompt_cache_key`. The dynamic suffix carries per-request state. The `Tokens —` digest is a compact, always-inlined summary of the site's design tokens (`describeAgentTokens(snap.site)`) so the agent sees the design system every turn without a `list_tokens` round-trip; when no tokens exist it reads `Tokens: (none — no design system yet; establish one first …)`. `list_tokens` remains the on-demand full-detail read (variants, utility classes).

---

## Why HTML-native

The previous tool surface required the model to reference internal module ids (`base.text`, `base.container`, …) and construct node trees as structured JSON. The current surface lets the model write plain HTML:

- LLMs produce correct semantic HTML far more reliably than custom JSON node-tree payloads.
- No module enumeration is needed in the system prompt — shorter context, lower token cost.
- The importer (`@core/htmlImport`) guarantees every element becomes a first-class editable `PageNode`: selectable, draggable, deletable, and re-styleable in the canvas.
- `getNodeHtml` (backed by the publisher's `renderNode`) gives the agent read-back at the same semantic level it writes.

The same importer that powers the Agent's `insertHtml` tool also powers the paste-HTML UI — see `docs/features/html-import.md`. No duplicated mapping logic.

**Reads are HTML-native.** The `read_document` tool returns the same semantic surface the agent writes: annotated HTML where every element carries `uid="<nodeId>"`, plus document-relevant CSS rather than the public full-site CSS bundle. It accepts document refs for pages, templates, and visual components, and omitting `document` reads the current editor document. The response is cleaned and size-budgeted; if `pageInfo.nextPart` is set, subsequent `read_document({ document, part })` calls return the remaining cleaned ranges. The agent reads `uid` values from the HTML and passes them verbatim to write tools — no separate node-lookup round-trip. Catalog tools (`list_modules`, `list_tokens`, `list_documents`, `list_post_types`, `list_loop_sources`, `list_breakpoints`) describe things not visible in the document HTML (what is insertable, design token CSS vars, editable document refs, CMS route targets, and loop binding fields) and remain as JSON tools.

---

## Client store (`agentSlice`)

`createAgentSlice(config)` (`src/admin/pages/site/agent/agentSlice.ts`) is a scope-agnostic Zustand slice factory. Scope-specific wiring is kept out of the factory — each surface supplies its own `AgentSliceConfig`. The site editor uses `siteAgentSliceConfig` from `agentSliceConfig.site.ts`:

```ts
// agentSliceConfig.site.ts — wired in store.ts via createAgentSlice(siteAgentSliceConfig)
export const siteAgentSliceConfig: AgentSliceConfig = {
  scope: 'site',
  buildSnapshot: () => buildCurrentPageContext(
    () => getAgentStoreApi<EditorStore>().getState(),
  ),
  dispatchTool: executeAgentTool,
  noProviderMessage: 'No AI provider configured for the site editor. …',
}
```

`getAgentStoreApi` reads the live store via `storeRef.ts`, wired in `store.ts` after store creation (`setAgentStoreApi(useEditorStore)`). This avoids a static import cycle: executor → store → agentSlice → executor.

The content workspace uses the same factory with `contentAgentSliceConfig` mounted in a standalone per-page store (`contentAgentStore.ts`).

Key slice state and actions:

```ts
interface AgentSlice {
  // ── UI state ──────────────────────────────────────────────────────────
  isAgentOpen:               boolean
  isAgentStreaming:          boolean
  agentMessages:             AgentMessage[]
  agentError:                string | null
  /** Active ai_conversations row id — created lazily on first send. */
  agentConversationId:       string | null
  /** Active (credentialId, modelId) surfaced by the model picker. */
  agentActiveCredentialId:   string | null
  agentActiveModelId:        string | null
  /** Conversation summaries for the history popover. */
  agentConversations:        ConversationView[]
  /**
   * Provider-normalised total input the model processed on the latest turn,
   * for the ContextMeter. Null for a fresh conversation (no turns yet); the
   * meter then shows 0 against the window. Hydrated from `ConversationView.contextTokens`
   * on loadAgentConversation; updated live from each turn's `usage` event.
   */
  agentContextTokens:        number | null

  // ── Actions ───────────────────────────────────────────────────────────
  openAgent():                                         void
  closeAgent():                                        void
  toggleAgent():                                       void
  sendAgentMessage(content: string):                   Promise<void>
  abortAgent():                                        void
  clearAgentMessages():                                void
  startNewAgentConversation():                         void
  loadAgentConversations():                            Promise<void>
  loadAgentConversation(id: string):                   Promise<void>
  deleteAgentConversation(id: string):                 Promise<void>
  /** Change which credential + model is active. Updates the conversation row if one exists; stages the values for the next create if not. Also clears `agentError` so a sticky "no provider" error doesn't keep the composer disabled after the user picks a model. */
  setAgentProvider(credentialId: string, modelId: string): Promise<void>
  /** Preload the per-scope default (credentialId, modelId) from GET /admin/api/ai/defaults. No-op when a conversation or explicit pick is already active. Called by AgentPanel on open. */
  loadScopeDefault():                                  Promise<void>
}
```

Conversations and their message history are persisted server-side in `ai_conversations` + `ai_messages`. `loadAgentConversation(id)` rehydrates a past thread into `agentMessages` without re-running the conversation.

**Content blocks are one schema.** Every message body is an `AiContentBlock[]` — a discriminated union of `text` / `image` / `toolCall` / `toolResult` kinds defined once as a TypeBox schema in `@core/ai` (`src/core/ai/contentBlock.ts`). The server runtime type (`AiContentBlock`), the read boundary (`ContentBlocksSchema` in `conversations/store.ts`, which validates every block out of `content_json`), and the client wire schema (`MessageViewSchema` in `src/admin/ai/api.ts`) all derive from it. Add a kind there and every reader/writer sees it.

**Tool outcomes are first-class.** A `role:'tool'` row records its result as a `{ kind: 'toolResult', ok, error? }` block — `ok` is an explicit boolean, never inferred from the emptiness of a text block. The persister writes it (`appendToolResult`), `buildMessageHistory` reads `ok`/`error` straight off the block to reconstruct the replay `AiToolOutput`, and the client folds it back into the matching tool-call badge (`rehydrateMessages`). The heavy successful `data` an `AiToolOutput` may carry is intentionally **not** persisted: the model already consumed it in the round that produced the result, so replay only needs `{ ok, error }` — re-feeding large tool payloads every turn would bloat the context for no benefit.

---

## Context meter and live model catalogue

### Context meter

The `<ContextMeter>` shows how much of the active model's context window the current conversation has consumed. Two data sources drive it:

- **Window** (`windowTokens` prop from `AgentPanel`): the model's max total tokens, resolved once from `GET /admin/api/ai/providers/:id/models?credentialId=…`. The models endpoint enriches Anthropic and OpenAI models with `contextWindow` from the live OpenRouter catalogue (`server/ai/pricing/`); OpenRouter populates it from its own native fetch. Ollama models and uncatalogued models have no window — the meter hides.
- **Used** (`agentContextTokens` in the store): the provider-normalised "context used" — the CURRENT context size, computed by `normalizeContextTokens(providerId, buckets)` in `server/ai/contextTokens.ts`:
  - Anthropic reports `input_tokens` excluding cache buckets, so the true total is `promptTokens + cacheReadTokens + cacheCreationTokens`.
  - OpenAI / OpenRouter / Ollama report `input_tokens` as the full input; `promptTokens` alone is the total.

**Live, per-round, not summed.** A turn makes one provider round-trip per tool batch. The toolLoop emits a `context` event **each round** carrying THAT round's input buckets; the chat handler injects the normalised `contextTokens` and the browser updates the meter on every round — so it climbs *during* a long tool loop instead of only at the end. The meter is the LATEST round's input (the current window fill), never the sum across rounds (which would over-count, since each round re-sends the growing context). The terminal `usage` event is **billing only** — its `promptTokens` stays summed across rounds (you pay input per round). The persister keeps the latest `context` value in memory (`recordContext`) and writes it once to `ai_conversations.context_tokens` with the final `usage` (overwritten per turn), so `loadAgentConversation` restores the true context on reload.

### Live model catalogue

`server/ai/pricing/` is the single source for per-model prices **and context windows**. It sources from OpenRouter's public `/api/v1/models` endpoint (no key required), which publishes list prices and `context_length` for Anthropic and OpenAI models. The module lifecycle:

- **Cold start**: loads the DB cache from `ai_model_pricing` (durable fallback) and kicks a background refresh. The first turn prices immediately off the last-known data.
- **No DB cache yet**: blocks once on a live fetch.
- **Thereafter**: serves from a 6-hour in-memory memo, refreshing in the background past the TTL.
- A failed refresh is logged and keeps the previous data — never fatal.

`pricingKey(modelId)` normalises a provider's native id (`claude-opus-4-8-20260514`) and the OpenRouter slug (`anthropic/claude-opus-4.8`) to the same key (`claude-opus-4-8`), stripping date suffixes, dots, and provider prefixes. Variant suffixes (`:thinking`, `-fast`) are preserved — they have different pricing.

The `getModelCatalogue(db)` export (used by the models handler for picker enrichment) and `resolveCostUsd(db, providerId, modelId, usage)` (used by the persister) share the same in-memory cache. Two callers, one memo.

### Auto-defaults on credential creation

When `POST /admin/api/ai/credentials` creates a new credential, `seedEmptyDefaults` auto-assigns it as the default for every scope (`site`, `content`, `data`, `plugin`) that has no default yet. The default model is the `tier === 'smartest'` live-catalogue entry from `driver.listModels()`, or the first live model if no smartest tier is found. If the model list can't be resolved (offline, bad key), seeding is skipped silently — it never fails the credential creation. Driver fallback models can still help the picker explain common local options, but they are not trusted for automatic defaults. Scopes that already point at a credential are left untouched.

Defaults can also be cleared per scope from the Defaults tab. The UI calls
`DELETE /admin/api/ai/defaults/:scope`, removes the row from `ai_defaults`, and
unblocks deletion of the credential that had been protected by the default FK.

---

## Abort + crash recovery

- **Abort.** "Stop" calls `agentSlice.abortAgent()` → `AbortController.abort()` → the fetch stream closes. When the abort signal fires on the server:
  - `req.signal` is passed straight to every `fetch()` call in the driver loop (`fetch(endpoint, { signal })`). The in-flight HTTP request to the provider is cancelled immediately — no further tokens are generated or billed. On `AbortError` the loop returns cleanly with no `error` event.
  - Any `callBrowser` promise still waiting for a browser tool-result rejects via the `onAbort` listener registered per pending call (in `server/ai/runtime/transport.ts`). The listener fires, clears the timeout, and removes the pending entry.
  - The stream's `destroy()` hook fires, rejects any remaining pending entries, and removes the bridge from the registry.
- **Interrupted tool calls.** If a stream aborts mid-turn — between the assistant's `tool_use` row write and the matching `tool_result` row write (e.g. `ERR_INCOMPLETE_CHUNKED_ENCODING`, server restart) — the persisted history has an unanswered `tool_use` block. `buildMessageHistory` in `server/ai/conversations/history.ts` heals the gap: every tool-call id that has no persisted `tool` result row gets a synthetic error result (`INTERRUPTED_TOOL_RESULT_ERROR`) injected before the next user turn. The model reads the error and can retry; the conversation is never permanently un-sendable. Adjacent synthetic results plus the following real user prompt are merged into one user turn by `pushUserContent` in `server/ai/drivers/anthropic.ts`, satisfying Anthropic's strict user/assistant alternation requirement.
- **Browser tool timeout.** If the browser never POSTs a tool-result, `callBrowser` rejects after 90 seconds (`BROWSER_TOOL_TIMEOUT_MS` in `server/ai/runtime/transport.ts`). The driver sees a rejection, emits an error, and the stream closes. This prevents a closed or unresponsive tab from hanging the tool loop indefinitely.
- **Crash on server.** If `runChat` throws, the stream emits `{ type: 'error', message }`. The browser surfaces the message verbatim in the Agent Panel (admin-only surface, so info-disclosure is not a concern).
- **Tool failure.** Browser executors wrap every call in try/catch. Failures return `{ ok: false, error }`. The model reads the error message in the next turn and retries with corrected input.
- **Bridge-result POST after abort.** If the browser POSTs a tool-result after the stream has closed, the server returns 404 and drops the result silently.
- **Page reload mid-stream.** The stream dies. The conversation row and its persisted messages survive. The user can reload the past thread via `loadAgentConversation` and re-send.

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Importing any provider SDK (`@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@openrouter/agent`, `@modelcontextprotocol/sdk`) | Banned repo-wide — no exceptions, including inside `server/ai/drivers/`. Drivers talk directly to the REST API. Gated by `ai-driver-isolation.test.ts`. |
| Importing `zod` anywhere | Banned repo-wide — TypeBox schemas pass directly as JSON Schema to every provider. Gated by `ai-driver-isolation.test.ts`. |
| Writing a private `parseToolArguments` / `parseJsonOrEmpty` copy inside a driver | Import `parseToolArguments` from `./http/toolArgs`. Private copies diverge silently — the same malformed model output produces different outcomes per provider. Gated by `ai-driver-shared-helpers.test.ts`. |
| Redefining `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in a driver or prompt builder | Import it from `server/ai/runtime/types.ts`. One source — if a driver or builder drifts the literal, prompt caching silently breaks for that driver. Gated by `ai-driver-shared-helpers.test.ts`. |
| Routing a write tool as a server-side read (resolving from snapshot) | Write tools are `execution: 'browser'` — they must go through the bridge. The editor store is the write authority. |
| Using invented breakpoint ids in `breakpointStyles` (`"mobile"`, `"desktop"`, etc.) | Use verbatim ids from the dynamic suffix. Invalid ids are rejected by the executor. |

---

## Related

- `docs/features/html-import.md` — the `importHtml` pipeline that `insertHtml` and `replaceNodeHtml` run through
- `docs/editor.md` — agent slice composition inside the editor store
- `docs/server.md` — handler routing; `/admin/api/ai/` is matched before `/admin/api/cms/`
- `docs/features/auth-and-access.md` — capability model (`ai.chat`, `ai.tools.write`)
- Source-of-truth files:
  - `src/core/ai/toolOutput.ts` — `AiToolOutput` type, `AiToolOutputSchema`, `aiToolOk`, `aiToolError` (canonical bridge result)
  - `src/core/ai/toolSchemas.ts` — all site browser-tool input schemas (single source of truth; imported by both the server registry and the browser executor)
  - `src/core/ai/documentRefs.ts` — document refs/descriptors for pages, templates, and visual components
  - `src/core/ai/readSurface.ts` — runtime-agnostic `renderAgentDocument` annotated HTML + compact CSS renderer
  - `src/core/ai/index.ts` — barrel re-exporting the above
  - `server/ai/tools/site/writeTools.ts` — 29 browser-bridged site tool definitions (uses `@core/ai` input schemas)
  - `server/ai/tools/site/readTools.ts` — 6 server-side catalog tool definitions
  - `server/ai/tools/site/render.ts` — `describeAgentModules`, `describeAgentTokens`, `filterTokenFamily`
  - `server/ai/tools/site/systemPrompt.ts` — HTML-native system prompt
  - `server/ai/tools/site/snapshot.ts` — `SiteAgentSnapshotSchema` + `SiteAgentSnapshot` re-export + catalog output types (`ModuleInfo`, `SnapshotTokens`, …)
  - `src/admin/pages/site/agent/siteAgentSnapshot.ts` — `SiteAgentSnapshotSchema` (TypeBox source of truth) + `SiteAgentSnapshot` (derived type) + `buildSiteAgentSnapshot`
  - `server/ai/handlers/chat.ts` — `POST /admin/api/ai/chat/site` endpoint
  - `server/ai/handlers/toolResult.ts` — `POST /admin/api/ai/tool-result` endpoint
  - `server/ai/conversations/history.ts` — `buildMessageHistory()` + `INTERRUPTED_TOOL_RESULT_ERROR` (heals interrupted tool calls)
  - `server/ai/conversations/store.ts` — `appendMessage`, `listMessagesForConversation`, `readConversationForUser`
  - `server/ai/runtime/runner.ts` — `runChat()` driver loop
  - `server/ai/contextTokens.ts` — `normalizeContextTokens()` — provider-normalised "context used" for the meter
  - `server/ai/pricing/index.ts` — `resolveCostUsd`, `getModelCatalogue`, `computeCostUsd`
  - `server/ai/pricing/openrouterCatalogue.ts` — `fetchOpenRouterCatalogue`, `pricingKey`, `ModelCatalogue`
  - `server/ai/pricing/store.ts` — durable `ai_model_pricing` DB cache
  - `server/ai/runtime/persister.ts` — `ConversationsPersister` interface + `createConversationsPersister()`
  - `server/ai/runtime/types.ts` — canonical `AiStreamEvent`, `AiMessage`, `AiTool`, `ToolContext` types
  - `server/ai/runtime/transport.ts` — `createBridge()` / `resolveBridgeToolResult()`
  - `server/ai/audit/store.ts` — `getUsageTotals`, `getUsageByUser`, `getUsageByScope`, `getUsageByModel`, `getUsageByDay` (usage rollup queries)
  - `server/ai/handlers/audit.ts` — `GET /admin/api/ai/audit` handler
  - `server/time.ts` — `resolveTimeZone` + `localDayKeyFactory` (shared timezone day-bucketing utilities)
  - `src/admin/pages/ai/AiPage.tsx` — `/admin/ai` workspace (Providers / Defaults / Audit tabs)
  - `src/admin/pages/ai/tabs/AuditTab.tsx` — usage audit view (totals strip, tables, daily bar chart)
  - `src/admin/pages/ai/tabs/UsageTablePanel.tsx` — shared table scaffolding for audit rollups
  - `src/admin/pages/ai/tabs/usageFormat.ts` — `formatNumber` / `formatCost` formatting helpers
  - `src/admin/pages/site/agent/agentSlice.ts` — scope-agnostic slice factory (`createAgentSlice`)
  - `src/admin/pages/site/agent/agentSliceConfig.site.ts` — site-editor scope config
  - `src/admin/pages/site/agent/agentApi.ts` — tool-result POST, conversation bootstrap, message rehydration
  - `src/admin/pages/site/agent/streamEvents.ts` — `ServerStreamEventSchema` + `processStreamEvent`
  - `src/admin/pages/site/agent/pageContext.ts` — `buildCurrentPageContext`
  - `src/admin/pages/site/agent/executor.ts` — write-tool browser dispatcher + auto-navigation
  - `src/admin/pages/site/agent/tokenRunners.ts` — design-system token tool runners (`set_color_tokens`, `set_font_tokens`, `set_type_scale`, `set_spacing_scale`)
  - `src/admin/pages/site/agent/agentConfig.ts` — API path constants
  - `src/admin/pages/site/agent/renderEvidence.ts` — `captureAgentRenderSnapshot`
  - `src/admin/pages/site/agent/types.ts` — `ServerStreamEvent`, `AgentMessage`, `AgentRequestBody`, …
  - `src/admin/pages/site/agent/index.ts` — public barrel
  - `src/admin/pages/content/agent/contentAgentStore.ts` — standalone content-workspace agent store
  - `src/admin/pages/site/panels/AgentPanel/AgentPanel.tsx` — Agent Panel; resolves `contextWindow` for the meter
  - `src/admin/pages/site/panels/AgentPanel/ContextMeter.tsx` — context used / window progress bar
- Gate tests:
  - `src/__tests__/architecture/ai-tool-schema-ssot.test.ts`
  - `src/__tests__/architecture/ai-driver-isolation.test.ts`
  - `src/__tests__/architecture/ai-tools-typebox-only.test.ts`
  - `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`
  - `src/__tests__/architecture/ai-driver-shared-helpers.test.ts`
