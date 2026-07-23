# MCP connections

MCP connections let external AI clients operate an Instatic instance through the [Model Context Protocol](https://modelcontextprotocol.io). Instatic is the MCP server: clients list its capability-filtered tools, run headless reads, relay editing tools to the connection owner's open workspace, and explicitly publish completed drafts.

This is the inverse of the **Providers** tab. Providers let Instatic call model APIs; MCP connections let outside clients call Instatic.

The wire server uses `@modelcontextprotocol/sdk`. That dependency remains allowed only under `server/ai/mcp/`; provider drivers continue to use their direct REST implementations.

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
| `transports/http.ts` | Stateless Web-standard Streamable HTTP transport. |
| `server.ts` / `registry.ts` | Low-level SDK server, TypeBox input schemas, catalog deduplication, and capability filtering. |
| `editorBridge.ts` | Per-user, per-scope live workspace bridge. |
| `tools/publishTool.ts` | Explicit canonical full-site publish with MCP audit metadata. |

## Tool execution model

MCP exposes the full deduplicated tool catalog, filtered by the connection's capabilities.

Server-resolved tools work without an editor open. They include content reads, `get_context`, `site_list_documents`, `site_read_styles`, `site_list_breakpoints`, and explicit `site_publish`. Publishing requires `ai.tools.write` plus `pages.publish`, runs the canonical full-site pipeline, swaps the static slot atomically, and records the connection id in the publish audit event.

Browser tools run against the connection owner's live workspace. Site structure, HTML/CSS, page lifecycle, design-token, content mutation, code-asset, and live-DOM tools route to the matching open Site or Content workspace. If that workspace is not open, the tool returns a scope-specific error while headless tools remain available.

There is intentionally no headless page-tree mutation path. The open editor store is the single source of truth for draft edits; a second DB mutation path would desynchronize node state and risk autosave overwrites. Successful relayed edits flush the draft before returning, so a following headless read or explicit publish sees the saved result.

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
- `src/__tests__/architecture/ai-mcp-connectors-never-leak.test.ts` gates the token-free connection projection.
