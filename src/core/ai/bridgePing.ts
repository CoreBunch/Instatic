/**
 * Liveness probe for a workspace bridge (the MCP relay's stream into an open
 * Site editor or Content workspace tab).
 *
 * `get_context` relays this pseudo-tool through the same stream and the same
 * client request loop every browser tool travels; the loop answers it itself
 * and never touches the workspace dispatcher. A registered stream whose loop
 * is stuck behind a tool that never settled, or whose connection died behind
 * a proxy without the server noticing, does not answer — which is the
 * difference between "a tab opened a stream at some point" and "browser tools
 * will work right now". Not a registered MCP tool: an external client cannot
 * call it by name.
 */
export const MCP_BRIDGE_PING_TOOL = 'mcp_bridge_ping'
