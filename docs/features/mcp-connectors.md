# MCP connections

MCP connections let external AI clients operate an Instatic instance through the [Model Context Protocol](https://modelcontextprotocol.io). Instatic is the MCP server: clients list its capability-filtered tools, run headless reads, relay editing tools to the connection owner's open workspace, and explicitly publish completed drafts.

This is the inverse of the **Providers** tab. Providers let Instatic call model APIs; MCP connections let outside clients call Instatic.

The wire server uses the stable split `@modelcontextprotocol/server` v2 package. That dependency remains allowed only under `server/ai/mcp/`; provider drivers continue to use their direct REST implementations.

## Connection modes

The UI exposes two credential lifecycles instead of a cosmetic local/remote switch:

| Mode | Intended client | Authentication | Lifecycle |
|---|---|---|---|
| Hosted OAuth | Claude custom connectors and other remote MCP clients | OAuth authorization code with S256 PKCE | The client discovers the authorization server, dynamically registers, and sends the user to Instatic for consent. Access tokens last up to one hour; refresh tokens rotate; the grant expires after 90 days. |
| Personal access token | Claude Code, Codex, Cursor, local bridges, and clients that accept an explicit header | `Authorization: Bearer imcp_pat_…` | Created after step-up authentication, shown once, scoped to selected capabilities, configurable expiry, independently revocable. |

Both modes resolve to the same persistent connection grant and the same `toolAllowedForCapabilities` gate. OAuth does not create a wider tool path.

The MCP endpoint is always:

```text
https://<your-host>/_instatic/mcp
```

Hosted clients run in their provider's infrastructure. They cannot reach `localhost`, a private LAN address, or an HTTP-only deployment. The MCP tab detects this and warns until Instatic's canonical public origin is HTTPS.

## Wire protocol

The endpoint uses the official v2 `createMcpHandler` Web-standard entry and serves stable MCP `2026-07-28`. That revision is stateless at the protocol layer:

- clients probe capabilities with `server/discover`; there is no modern `initialize` / `notifications/initialized` handshake;
- every request carries `MCP-Protocol-Version: 2026-07-28`, the required `Mcp-Method` routing header, and `Mcp-Name` when the operation addresses a named tool/resource/prompt;
- the request's `params._meta` carries the protocol version, client identity, and client capabilities;
- the endpoint never creates or returns `Mcp-Session-Id` for modern requests.

The same handler keeps the SDK's `legacy: 'stateless'` fallback enabled. Clients speaking a 2025-era revision may still send an `initialize` request and then make independent authenticated POSTs, but no protocol session is created. This compatibility path can be removed when supported clients have all migrated.

Every request is bearer-authenticated before the SDK dispatches it. Browser-originated requests are also checked against Instatic's configured public-origin policy before authentication or dispatch; requests without `Origin` remain valid for native and server-to-server MCP clients.

See the official [TypeScript SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md), [stable MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28), and [release changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) for the wire revision.

## Hosted OAuth flow

Instatic implements the MCP authorization-server surface directly:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 protected-resource metadata for the MCP resource. |
| `/.well-known/oauth-protected-resource/_instatic/mcp` | Path-aware protected-resource discovery alias. |
| `/.well-known/oauth-authorization-server` | Authorization-server metadata. |
| `/_instatic/oauth/register` | Dynamic client registration for public clients. |
| `/admin/ai/oauth/authorize` | Signed-in consent screen. |
| `/_instatic/oauth/token` | Form-encoded authorization-code and refresh-token exchange. |

The authorization sequence is:

```text
Hosted MCP client
  → reads protected-resource and authorization-server metadata
  → dynamically registers its exact callback URI
  → opens /admin/ai/oauth/authorize with resource + state + S256 challenge
  → user signs in, reviews the client, selects capabilities, and completes step-up
  → Instatic redirects a one-time code to the registered callback
  → client exchanges code + verifier for opaque access and refresh tokens
  → client calls /_instatic/mcp with the access token
```

Security properties:

- Public clients only: no generated client secret is required or stored.
- Redirect URIs are registered exactly. HTTPS is required except for HTTP loopback callbacks used by native clients.
- Authorization codes expire after five minutes, are stored only as SHA-256 hashes, and can be consumed once.
- S256 PKCE, exact client id, callback, and MCP `resource` binding are checked during exchange.
- OAuth access tokens are opaque, stored only as hashes, bound to the exact MCP resource, and expire after at most one hour.
- Refresh tokens rotate on every use. Reuse of a rotated token revokes the connection and all of its tokens.
- OAuth grants expire after 90 days. Disconnecting the connection immediately invalidates its access and refresh tokens.
- The consent API requires `ai.providers.manage`; approval also requires a fresh step-up window. The approver cannot delegate a capability they do not hold.
- Dynamic-registration client names are self-declared. The consent screen surfaces the exact callback and tells the approver to verify that they initiated the request and recognize the address.
- The client-supplied `state` value is round-tripped on success and denial. Redirects are generated only from the callback already registered for that client.

### Claude Desktop / Claude custom connector

1. Deploy Instatic at a public HTTPS origin and configure that origin through the normal server public-origin configuration.
2. In Instatic, open **AI → MCP** and copy the **Remote MCP URL**.
3. In Claude, open **Settings → Connectors**, add a custom connector, choose a name, and paste the URL.
4. Leave **OAuth Client ID** and **OAuth Client Secret** empty. Claude can dynamically register as a public PKCE client.
5. Choose **Connect**. The browser returns to Instatic, where the user selects capabilities and approves the connection.

The resulting OAuth connection appears automatically under **Authorized connections**. No Instatic token is copied into Claude.

## Personal access tokens

In **AI → MCP**, choose **Create access token**, name the device/client, choose an expiry and capabilities, then complete step-up. The plaintext `imcp_pat_…` token is returned once; only its SHA-256 hash is stored.

Claude Code example:

```sh
claude mcp add instatic --transport http http://localhost:3000/_instatic/mcp \
  --header "Authorization: Bearer imcp_pat_…"
```

Claude Desktop can also reach a local server through a local stdio bridge. The UI generates a ready-to-copy `mcp-remote` configuration that keeps the token in an environment variable instead of embedding it in the command arguments.

Personal tokens are deliberately not the hosted-connector setup path. The hosted Claude connector form does not provide a general custom-header field, and a cloud-hosted connector cannot reach a local-only endpoint.

## Architecture

```text
MCP client
  │ Streamable HTTP + OAuth/PAT bearer
  ▼
server/router.ts
  ├─ OAuth metadata / registration / token endpoints
  └─ /_instatic/mcp
       ▼
server/ai/mcp/auth.ts
  bearer → OAuth access token or personal token → connection capability set
       ▼
server/ai/mcp/server.ts + registry.ts
  capability-filtered MCP tools
       ▼
executeAiTool(...) / live editor bridge
  ├─ repositories and publisher for headless tools
  └─ connection owner's open Site or Content workspace for browser tools
```

### Module layout

| Module | Responsibility |
|---|---|
| `paths.ts` | Canonical MCP, OAuth, metadata, and consent paths. |
| `oauth/protocol.ts` | Issuer/resource construction, supported scopes, redirect validation, PKCE validation, safe callback generation. |
| `oauth/schemas.ts` | TypeBox schemas for dynamic registration and form/query parsing. |
| `oauth/handler.ts` | Public metadata, dynamic registration, and token endpoints with protocol-shaped errors and rate limits. |
| `oauth/store.ts` | Registered clients, hashed one-time codes, token issue/rotation, resource-bound access lookup. |
| `handlers/oauthAuthorization.ts` | Admin-session consent read/decision API, capability floor, and step-up gate. |
| `handlers/management.ts` | Connection overview, personal-token creation, and revoke/disconnect. |
| `connectors/store.ts` | Persistent connection grant and the token-free `toConnectionView` projection. |
| `connectors/token.ts` | Opaque secret generation, hashing, and PKCE challenge calculation. |
| `auth.ts` | Resolves OAuth access tokens or personal tokens to `{ connectorId, userId, capabilities }`; returns a discovery-aware 401 otherwise. |
| `transports/http.ts` | Authenticated, Origin-validated `createMcpHandler` entry for MCP 2026-07-28 plus the stateless 2025 fallback. |
| `server.ts` / `registry.ts` | Low-level SDK server, TypeBox input schemas, catalog deduplication, and capability filtering. |
| `editorBridge.ts` | Per-user, per-scope live workspace bridge. The stream carries an **idle lease** (120s, re-armed by every relayed tool request) so an active batch is never cut mid-flight; only quiet streams recycle. The workspace's reconnect loop (`useMcpWorkspaceBridge`) reopens a recycled healthy stream immediately off the stream-end network event — deliberately timer-free, because hidden webviews (backgrounded browser tabs) clamp timers to minutes while network events still fire — and a tab becoming visible short-circuits any pending retry delay. |
| `tools/publishTool.ts` | Explicit canonical full-site publish with MCP audit metadata. |
| `tools/uploadMediaTool.ts` | Server-resolved image upload (`media_upload`) — inline base64 or SSRF-guarded `sourceUrl` download, through the shared media pipeline. |
| `../tools/data/` | Server-resolved schema and row tools for reusable data tables (`data_*`). Shared with the in-app `data` chat scope; the MCP registry passes a runtime so writes are attributed to the connection. |

## What `tools/list` advertises

Each tool ships three things beyond its name and description.

`inputSchema` is the tool's TypeBox schema emitted verbatim as JSON Schema. The same schema re-validates the arguments inside `executeAiTool`, so the advertised contract and the enforced one cannot drift.

`outputSchema` describes the result. The server sends the payload twice on success: as JSON text in `content`, for clients that read only that, and as `structuredContent`, a typed object matching the schema. Nothing validates a result against its schema at runtime — a shape drift must fail a test, never break a tool on a live install — so the catalog test in `registry.test.ts` requires every advertised tool to declare one and the per-tool tests assert the match. Schemas live in `src/core/ai/toolOutputSchemas.ts`, in core because browser tools produce their results in the browser and the server advertises them. Where a tool forwards a structure another engine owns (a page-node tree, a module's prop schema) the leaf stays `unknown` with a description rather than a second definition to drift from the first.

`annotations` carry the four MCP behaviour hints, derived in `server.ts`:

| Hint | How it is set |
|---|---|
| `readOnlyHint` | true unless the tool is tagged `mutates` |
| `destructiveHint` | true for the row/document/node/page deletes, `data_update_table` (dropping a field orphans its values), and `site_publish` (overwrites the live slot) |
| `idempotentHint` | true for reads and for writes that land in the same state when repeated — status changes, deletes, field and token setters |
| `openWorldHint` | always false; every tool reaches this install's own database and uploads, nothing else |

They are hints for a client's confirmation UI, not a security boundary. Capabilities are the boundary.

## Tool execution model

MCP exposes the full deduplicated tool catalog, filtered by the connection's capabilities.

Server-resolved tools work without an editor open. They include content reads, the whole `data_*` toolset, `get_context`, `site_list_documents`, `site_read_styles`, `site_list_breakpoints`, `media_upload`, and explicit `site_publish`. Publishing requires `ai.tools.write` plus `pages.publish`, runs the canonical full-site pipeline, swaps the static slot atomically, and records the connection id in the publish audit event.

`media_upload` is the one server-resolved write that mutates outside the live editor draft: it adds an image to the Media library through the same `acceptUploadedMedia` core the HTTP route uses (magic-byte sniffing, SVG sanitisation, storage dispatch, responsive variants). Bytes arrive inline (base64) or via an https `sourceUrl` the host downloads under the plugin network layer's SSRF blocklist — https-only, DNS-resolved, per-redirect-hop re-validation, size-capped. It requires `ai.tools.write` plus `media.write`.

### Reusable data tables

`content_*` covers post types — documents with a Tiptap body the Content workspace renders. Reusable tables (`kind: 'data'`: a training catalogue, a team roster, anything a page loops over) are a different shape: a grid of typed cells with no body, and `content_list_collections` deliberately does not list them.

They get their own headless toolset instead of being folded into `content_*`, because routing a cell write through an open browser tab would buy nothing and would make the toolset unusable from a script or a remote agent:

| Tool | Does | Requires |
|---|---|---|
| `data_list_tables` | Lists data tables and post types with slug, kind, route base, row count, and primary field. Page, component, and layout tables stay hidden — those are Site-editor documents. | a table read/manage capability |
| `data_create_table` | Creates a table with its fields. `kind: 'data'` gets no route base, so its rows have no public URL; `kind: 'postType'` gets `/<slug>`. | `data.custom.tables.manage` |
| `data_update_table` | Changes identity or replaces the field array. | a table manage capability |
| `data_add_fields` | Appends fields, leaving stored values untouched — the safe way to evolve a schema. | a table manage capability |
| `data_create_rows` | Creates up to 200 rows in one transaction. Any rejection writes nothing. | `content.create` |
| `data_update_row` | Patches one row's cells (merge by default). | a content edit capability |
| `data_set_rows_status` | Publishes, unpublishes, or drafts rows in bulk, reporting per-row outcomes. | publish for `published`, edit otherwise |
| `data_delete_rows` | Soft-deletes rows in bulk. | a content edit capability |

The capability in the last column only decides whether a tool is offered. Every row tool then checks the row itself the way the HTTP row routes do (`loadRowForTool` in `server/ai/tools/data/access.ts`, the twin of `loadRowForAccess`): first the table-family read boundary (`canReadTable`), then the per-row edit or publish predicate. The order matters. A broad `content.*` capability passes the row check on any row, so without the table check first, a connector that may read only custom tables could still edit, publish, or delete `pages` and `posts` rows. A row that fails either check is reported as not found, so a forbidden table family stays invisible.

Schema writes are granted separately from row writes: `data.custom.tables.manage` is its own **Data tables** section on the consent screen and in the access-token dialog, off by default. A connector that only fills rows never gets it, and an approver who does not hold it never sees the section. `data.system.tables.manage` is not offered at all — the four built-in tables refuse identity and built-in-field changes regardless, so the grant would read wider than it acts.

Reading rows back is `content_list_documents` and `content_get_document`: both accept a reusable data table's id exactly as they accept a post type's, and `content_get_collection_schema` returns the field ids that `data_create_rows` keys its cells by. There is deliberately no `data_list_rows` / `data_get_row` duplicating them; the three descriptions point at each other so an agent finds the path from either side.

Headless calls always run on `main`. The MCP request context pins `MAIN_SCOPE`, so a connector reads and writes the live site's rows and never a site branch's; only the in-app Data chat carries the workspace's branch through the same tools. `data_set_rows_status` refuses a publish off main for the same reason the HTTP route answers 409 — publishing writes main regardless of the branch the row was read from — while retracting and deleting work on a branch and leave main's baked artefact and render cache alone.

Publishing a row in a table with no route base is allowed and normal. No static artefact is baked because there is no route to bake it at, but the row becomes `published`, which is what an `<instatic-loop>` on some other page reads.

The system tables (`pages`, `posts`, `components`, `layouts`) accept new custom fields but refuse any change to their identity or their built-in fields, enforced by the same `assertSystemTableUpdateAllowed` the HTTP route uses.

Browser tools run against the connection owner's live workspace. Site structure, HTML/CSS, page lifecycle, design-token, content mutation, code-asset, and live-DOM tools route to the matching open Site or Content workspace. If that workspace is not open, the tool returns a scope-specific error while headless tools remain available. `tools/list` states that requirement in each browser tool's description, so a client learns the precondition when it picks the tool rather than from a failed call.

There is intentionally no headless page-tree mutation path. The open editor store is the single source of truth for draft edits; a second DB mutation path would desynchronize node state and overwrite the live document. Relayed edits need no post-tool save step: store mutations stream to the collab relay the moment they land, and every headless read (plus `site_publish`) flushes the relay server-side before it touches the DB — so a following read or publish always observes the edit. There is no client-side save flush, and no window in which the MCP caller can see stale data.

Writes remain drafts. Clients should finish and verify an edit sequence, then call `site_publish` once only when deployment was requested.

## Data model

`ai_mcp_connectors` remains the persistent owner/capability grant (migrations `018` and `019`):

| Column | Notes |
|---|---|
| `id`, `user_id`, `label` | Connection identity and owner. |
| `auth_mode` | `bearer` for personal access tokens, `oauth` for hosted grants. |
| `token_hash` | Personal-token hash; `NULL` for OAuth connections. |
| `capabilities_json` | Granted capability subset. |
| `created_at`, `last_used_at`, `revoked_at`, `expires_at` | Shared lifecycle. |
| `type` | Legacy storage discriminator retained in the existing live schema; it is no longer exposed as a product choice or wire field. |

Migration `021_mcp_oauth` adds, in both dialects:

- `ai_mcp_oauth_clients`: dynamically registered public clients and exact callback lists;
- `ai_mcp_oauth_codes`: hashed, short-lived, one-time PKCE authorization codes;
- `ai_mcp_oauth_tokens`: hashed access/refresh tokens with kind, client, scope, resource, expiry, and revocation state.

The wire-safe `McpConnectionView` never includes a token or hash. Personal-token creation is the only response that contains a plaintext personal token. OAuth codes and tokens stay on the protocol endpoints and never appear in list/read APIs.

Create and manual revoke actions retain the existing `ai.mcp_connector.created` and `ai.mcp_connector.revoked` audit events, with the authentication mode included in create metadata.

## Capability enforcement

- Management and consent require `ai.providers.manage`.
- Token creation and OAuth approval require step-up authentication.
- Mutating tools require `ai.tools.write`.
- Page-tree edits require the matching site/page edit capabilities.
- Full-site deployment additionally requires `pages.publish`.
- Own-vs-any content permissions are checked again against the target row before browser relay.
- The approver can grant only capabilities they hold.

## Tests

- `server/ai/mcp/oauth/handler.test.ts` covers discovery metadata, public dynamic registration, and callback policy.
- `server/ai/mcp/oauth/store.test.ts` covers PKCE exchange, exact binding, one-time codes, access lookup, refresh rotation/reuse, and revocation.
- `server/ai/mcp/auth.test.ts` covers personal and OAuth bearer resolution plus the protected-resource challenge.
- `src/__tests__/ai/mcpOAuthAuthorizationHandler.test.ts` covers signed-in consent, capability selection, exact callback redirects, denial, and privilege floors.
- `src/__tests__/ai/mcpConnectorsHandler.test.ts` covers connection listing, personal-token creation, step-up, revoke, and privilege floors.
- `server/ai/mcp/e2e.test.ts`, `transports/http.test.ts`, and `publishTool.test.ts` cover the real MCP request flow and publish path.
- `server/ai/tools/data/*.test.ts` cover the data toolset against a migrated SQLite database: system-table refusals, transactional batches, slug-conflict naming, and publishing a row in a non-routable table.
- `src/__tests__/architecture/ai-mcp-connectors-never-leak.test.ts` gates the token-free connection projection.
