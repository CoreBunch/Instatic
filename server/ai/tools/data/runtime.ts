/**
 * Per-connection context the data tools need but `ToolContext` does not carry.
 *
 * `uploadsDir` is required to bake a row's static artefact on publish and to
 * unlink it again on retract or delete, so BOTH paths that expose these tools
 * must supply it: the MCP server from its transport options, the in-app chat
 * handler from the server runtime. Without it a retract would update the
 * database and leave the baked page on disk, where Layer A keeps serving it.
 *
 * `connectorId` is what makes an MCP write attributable in the audit log, so
 * it is set only on the MCP path — the in-app agent has no connector and its
 * writes are attributed to the signed-in user as `source: 'agent'`.
 *
 * Structurally compatible with `McpPublishRuntime` and filled from the same
 * object, declared here so `server/ai/tools/` does not import from
 * `server/ai/mcp/`.
 */
export interface DataToolsRuntime {
  /** Present on the MCP path only; its absence is what marks an in-app write. */
  connectorId?: string
  uploadsDir: string
}
