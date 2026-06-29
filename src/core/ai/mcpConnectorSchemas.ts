/**
 * Wire schemas for MCP connectors — the configured integrations that let an
 * external MCP client (Claude Code, Codex, a remote agent) reach into this
 * Instatic instance and drive its tools.
 *
 * Shared between the server handlers (`server/ai/mcp/handlers`) and the admin
 * UI (`src/admin/ai/api.ts`) so a single TypeBox definition validates both
 * sides of the wire. The plaintext token is surfaced EXACTLY ONCE, in the
 * create response — never in any list/read projection.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { CORE_CAPABILITIES } from '@core/capabilities'

export const McpConnectorTypeSchema = Type.Union([
  Type.Literal('local'),
  Type.Literal('remote'),
])
export type McpConnectorType = Static<typeof McpConnectorTypeSchema>

export const McpAuthModeSchema = Type.Union([
  Type.Literal('bearer'),
  Type.Literal('oauth'),
])
export type McpAuthMode = Static<typeof McpAuthModeSchema>

/** Closed enum over the capability vocabulary — bodies are validated, not free text. */
const CapabilitySchema = Type.Union(CORE_CAPABILITIES.map((c) => Type.Literal(c)))

/** Wire-safe projection — the only connector shape the HTTP layer returns. No token. */
export const McpConnectorViewSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  type: McpConnectorTypeSchema,
  authMode: McpAuthModeSchema,
  capabilities: Type.Array(CapabilitySchema),
  createdAt: Type.String(),
  lastUsedAt: Type.Union([Type.String(), Type.Null()]),
  revoked: Type.Boolean(),
})
export type McpConnectorView = Static<typeof McpConnectorViewSchema>

export const CreateMcpConnectorBodySchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 120 }),
  type: McpConnectorTypeSchema,
  capabilities: Type.Array(CapabilitySchema, { minItems: 1 }),
})
export type CreateMcpConnectorBody = Static<typeof CreateMcpConnectorBodySchema>

/** Response to a successful create — carries the plaintext token EXACTLY ONCE. */
export const CreateMcpConnectorResultSchema = Type.Object({
  connector: McpConnectorViewSchema,
  token: Type.String(),
})
export type CreateMcpConnectorResult = Static<typeof CreateMcpConnectorResultSchema>

export const McpConnectorListSchema = Type.Object({
  connectors: Type.Array(McpConnectorViewSchema),
})
export type McpConnectorList = Static<typeof McpConnectorListSchema>

export const RevokeMcpConnectorResultSchema = Type.Object({
  revoked: Type.Boolean(),
})
export type RevokeMcpConnectorResult = Static<typeof RevokeMcpConnectorResultSchema>
