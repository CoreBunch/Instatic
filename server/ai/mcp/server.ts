/**
 * Build a capability-scoped MCP `Server` over Instatic's existing tool engine.
 *
 * We use the low-level SDK `Server` + `setRequestHandler` (not the higher-level
 * `McpServer.registerTool`, which requires Zod schemas — banned repo-wide).
 * This lets us advertise our canonical TypeBox `inputSchema` verbatim as JSON
 * Schema (exactly as the AI drivers send it to providers) and run each call
 * through `executeAiTool`, which already does TypeBox input validation, a
 * capability re-check, and `{ ok, data | error }` normalisation.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { DbClient } from '../../db/client'
import type { CoreCapability } from '@core/capabilities'
import type { AiBrowserBridge, AiTool } from '../runtime/types'
import { executeAiTool } from '../drivers/http/execTool'
import { mcpToolsForCapabilities } from './registry'
import { getEditorBridgeForUser } from './editorBridge'

export interface McpServerContext {
  db: DbClient
  userId: string
  connectorId: string
  capabilities: readonly CoreCapability[]
}

// Used for server-resolved tools, which never call the bridge.
const NOOP_BRIDGE: AiBrowserBridge = {
  callBrowser: async () => {
    throw new Error('[ai:mcp] this tool has no server handler and no live editor bridge')
  },
}

const NO_EDITOR_MESSAGE =
  'This tool runs in the Instatic editor. Open the site editor in a browser (signed in as the connector owner) and try again.'

export function buildMcpServer(ctx: McpServerContext): Server {
  const server = new Server(
    { name: 'instatic', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  const tools = mcpToolsForCapabilities(ctx.capabilities)
  const byName = new Map<string, AiTool>(tools.map((t) => [t.name, t]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      // Our TypeBox object schema IS a valid JSON-Schema tool definition. The
      // `AiTool.inputSchema` field is the general `TSchema`, so we adapt it to
      // the SDK's object-schema shape (a type-level adaptation, not a runtime
      // data boundary — every MCP tool's schema is a `Type.Object`).
      inputSchema: t.inputSchema as unknown as { type: 'object'; properties?: Record<string, unknown> },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params
    const tool = byName.get(name)
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
    }

    // Server-resolved tools run in-process; browser tools are relayed to the
    // connector owner's open editor. No editor → a clear, actionable error.
    let bridge = NOOP_BRIDGE
    if (tool.execution === 'browser') {
      const live = getEditorBridgeForUser(ctx.userId)
      if (!live) {
        return { isError: true, content: [{ type: 'text', text: NO_EDITOR_MESSAGE }] }
      }
      bridge = live
    }

    const controller = new AbortController()
    const output = await executeAiTool(tool, args ?? {}, bridge, controller.signal, {
      db: ctx.db,
      userId: ctx.userId,
      capabilities: ctx.capabilities,
      scope: tool.scope === 'shared' ? 'content' : tool.scope,
      conversationId: `mcp:${ctx.connectorId}`,
      snapshot: null,
    })

    if (!output.ok) {
      return { isError: true, content: [{ type: 'text', text: output.error ?? 'Tool failed.' }] }
    }
    // A tool that mutates but returns no payload (e.g. deleteNode) must still
    // read as an unambiguous success — never the literal "null".
    const payload = output.data === undefined || output.data === null ? { ok: true } : output.data
    const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(payload) }]
    // Forward image attachments (e.g. render_snapshot's PNG) as MCP image
    // content blocks so vision clients actually receive the screenshot — they
    // travel on `output.images`, never inlined into the text payload.
    for (const image of output.images ?? []) {
      content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
    }
    return { content }
  })

  return server
}
