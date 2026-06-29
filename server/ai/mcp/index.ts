/**
 * MCP server module — Instatic as an MCP server. External MCP clients (Claude
 * Code, Codex, remote agents) connect here and drive the CMS tools.
 */
export { handleMcpHttp, MCP_ENDPOINT_PATH } from './transports/http'
