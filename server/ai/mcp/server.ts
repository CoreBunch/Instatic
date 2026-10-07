/**
 * Build a capability-scoped MCP `Server` over Instatic's existing tool engine.
 *
 * We use the low-level SDK `Server` + `setRequestHandler` so our canonical
 * TypeBox `inputSchema` remains the source of truth and is advertised verbatim
 * as JSON Schema (exactly as the AI drivers send it to providers). Each call
 * still runs through `executeAiTool`, which already does TypeBox input
 * validation, a capability re-check, and `{ ok, data | error }`
 * normalisation.
 */
import {
  Server,
  type CallToolResult,
  type JSONValue,
  type Tool,
  type ToolAnnotations,
} from '@modelcontextprotocol/server'
import type { TSchema } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../../db/client'
import type { CoreCapability } from '@core/capabilities'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { AiBrowserBridge, AiTool, AiToolOutput } from '../runtime/types'
import { executeAiTool } from '../drivers/http/execTool'
import { mcpToolsForCapabilities } from './registry'
import { authorizeMcpContentTool } from './contentAuthorization'
import { getEditorBridgeBranch, getEditorBridgeForUser, type EditorBridgeScope } from './editorBridge'
import { runPublishFlush } from '../../publish/publishFlush'
import { MAIN_SCOPE } from '../../branches/scope'
import { version as INSTATIC_VERSION } from '../../../package.json'

export interface McpServerContext {
  db: DbClient
  userId: string
  connectorId: string
  capabilities: readonly CoreCapability[]
  uploadsDir?: string
}

// Used for server-resolved tools, which never call the bridge.
const NOOP_BRIDGE: AiBrowserBridge = {
  callBrowser: async () => {
    throw new Error('[ai:mcp] this tool has no server handler and no live editor bridge')
  },
}

const NO_WORKSPACE_MESSAGE: Record<EditorBridgeScope, string> = {
  site: 'This tool runs in the Instatic Site editor. Open the Site editor in a browser (signed in as the connector owner) and try again.',
  content: 'This tool runs in the Instatic Content workspace. Open the Content workspace in a browser (signed in as the connector owner) and try again.',
}

/**
 * Same requirement as `NO_WORKSPACE_MESSAGE`, stated up front.
 *
 * An MCP client picks its tools from `tools/list` and nothing else, so a
 * browser tool that reads like a headless one gets called blind: the model
 * only learns the editor has to be open by burning a turn on the failure. That
 * is the wrong end of the loop to teach it from — it can neither open the
 * editor itself nor tell from the error whether retrying is worthwhile, so it
 * retries anyway. Advertising the precondition alongside the description lets
 * the model ask the user to open the workspace before it spends anything.
 */
const BROWSER_WORKSPACE_REQUIREMENT: Record<EditorBridgeScope, string> = {
  site: 'Requires the Instatic Site editor to be open in a browser, signed in as the connector owner; this tool edits that live workspace and cannot run headlessly.',
  content: 'Requires the Instatic Content workspace to be open in a browser, signed in as the connector owner; this tool edits that live workspace and cannot run headlessly.',
}

/** Tool description as advertised over MCP — browser tools carry their precondition. */
function advertisedDescription(tool: AiTool): string {
  if (tool.execution !== 'browser') return tool.description
  if (tool.scope !== 'site' && tool.scope !== 'content') return tool.description
  return `${tool.description}\n\n${BROWSER_WORKSPACE_REQUIREMENT[tool.scope]}`
}

/**
 * TypeBox schemas are JSON Schema plus symbol-keyed runtime metadata. MCP v2
 * validates the advertised schema as JSON data, so project only the enumerable
 * string-keyed JSON value while preserving the canonical schema itself.
 */
function plainJsonValue(value: unknown): JSONValue {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : plainJsonValue(item))
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value !== 'object') {
    throw new TypeError('TypeBox schema contains a non-JSON value')
  }

  const out: Record<string, JSONValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = plainJsonValue(item)
  }
  return out
}

function plainObjectSchema(schema: TSchema, label: string): Tool['inputSchema'] {
  const value = plainJsonValue(schema)
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    value.type !== 'object'
  ) {
    throw new TypeError(`MCP tool ${label} schema must be a JSON Schema object`)
  }
  return value as Tool['inputSchema']
}

function isJsonObject(value: unknown): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Tool annotations
// ---------------------------------------------------------------------------

/**
 * Tools whose effect cannot be undone from the tool surface itself.
 *
 * `mutates` already separates reads from writes; this is the narrower
 * question a client asks before prompting a human. Row deletes are soft and
 * recoverable in the database, but not through any tool here, so they count.
 * `data_update_table` is included because its `fields` array REPLACES the
 * schema — an omitted field orphans every value stored under it.
 */
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'data_delete_rows',
  'data_update_table',
  'content_delete_document',
  'site_delete_node',
  'site_delete_page',
  'site_publish',
])

/**
 * Tools where a repeat call with the same arguments lands on the same state.
 * Setting a status or a token set is idempotent; inserting a node or creating
 * a row is not — calling it twice produces two of the thing.
 */
const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  'data_set_rows_status',
  'data_delete_rows',
  'data_update_row',
  'data_update_table',
  'content_set_document_status',
  'content_set_document_field',
  'content_set_document_fields',
  'content_set_document_author',
  'content_delete_document',
  'site_set_color_tokens',
  'site_set_font_tokens',
  'site_set_type_scale',
  'site_set_spacing_scale',
  'site_set_page_template',
  'site_clear_page_template',
  'site_delete_node',
  'site_delete_page',
])

/**
 * Behavioural hints for the client, derived from what the registry already
 * knows. They are hints, not a security boundary — `toolAllowedForCapabilities`
 * and the per-tool capability re-check are what actually gate a call.
 *
 * `openWorldHint` is false throughout: every tool reads or writes this
 * instance's own database, uploads directory, and open editor. None of them
 * reaches an external service whose result could vary independently.
 */
function advertisedAnnotations(tool: AiTool): ToolAnnotations {
  const readOnly = tool.mutates !== true
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && DESTRUCTIVE_TOOLS.has(tool.name),
    idempotentHint: readOnly || IDEMPOTENT_TOOLS.has(tool.name),
    openWorldHint: false,
  }
}

export function buildMcpServer(ctx: McpServerContext): Server {
  const server = new Server(
    { name: 'instatic', version: INSTATIC_VERSION },
    { capabilities: { tools: {} } },
  )

  const tools = mcpToolsForCapabilities(
    ctx.capabilities,
    ctx.uploadsDir
      ? { connectorId: ctx.connectorId, uploadsDir: ctx.uploadsDir }
      : undefined,
  )
  const byName = new Map<string, AiTool>(tools.map((t) => [t.name, t]))

  server.setRequestHandler('tools/list', async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: advertisedDescription(t),
      // Every MCP tool schema is a Type.Object. Remove TypeBox's symbol-keyed
      // runtime annotations before handing the otherwise unchanged JSON Schema
      // to the v2 wire validator.
      inputSchema: plainObjectSchema(t.inputSchema, 'input'),
      ...(t.outputSchema
        ? { outputSchema: plainObjectSchema(t.outputSchema, 'output') }
        : {}),
      annotations: advertisedAnnotations(t),
    })),
  }))

  server.setRequestHandler('tools/call', async (request, requestContext): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params
    const tool = byName.get(name)
    // The advertised schema is what the SDK's era projection reconciles a
    // result against, so hand it the same object `tools/list` published.
    const advertisedOutput = tool?.outputSchema
      ? plainObjectSchema(tool.outputSchema, 'output')
      : undefined
    const project = (result: CallToolResult) =>
      server.projectCallToolResult(result, advertisedOutput)
    if (!tool) {
      return project({ isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] })
    }

    // Server-resolved tools run in-process; browser tools are relayed to the
    // connector owner's matching open workspace. No workspace → a clear,
    // actionable error. Browser tools currently belong only to Site or
    // Content; keep that invariant explicit instead of guessing a bridge.
    let bridge = NOOP_BRIDGE
    if (tool.execution === 'browser') {
      if (tool.scope !== 'site' && tool.scope !== 'content') {
        return project({
          isError: true,
          content: [{ type: 'text', text: `Browser tool "${tool.name}" has unsupported scope "${tool.scope}".` }],
        })
      }
      const browserScope: EditorBridgeScope = tool.scope
      const live = getEditorBridgeForUser(ctx.userId, browserScope)
      if (!live) {
        return project({
          isError: true,
          content: [{ type: 'text', text: NO_WORKSPACE_MESSAGE[browserScope] }],
        })
      }
      bridge = browserScope === 'content'
        ? {
            callBrowser: async (toolName, input) => {
              await authorizeMcpContentTool(
                ctx.db,
                ctx.userId,
                ctx.capabilities,
                toolName,
                input,
                { branchId: getEditorBridgeBranch(ctx.userId, browserScope) ?? MAIN_SCOPE.branchId },
              )
              const current = getEditorBridgeForUser(ctx.userId, browserScope)
              if (!current) throw new Error(NO_WORKSPACE_MESSAGE[browserScope])
              return current.callBrowser(toolName, input)
            },
          }
        : live
    } else {
      // Headless reads hit the DB directly, but live co-editing persists on an
      // ~800 ms debounce — flush the relay first so a headless read reflects
      // edits still in flight in an open editor. Cheap: a clean doc's flush is
      // a no-op (persistNow early-returns when not dirty).
      await runPublishFlush()
    }

    let output: AiToolOutput
    try {
      output = await executeAiTool(tool, args ?? {}, bridge, requestContext.mcpReq.signal, {
        db: ctx.db,
        // Headless MCP reads describe the live site. Browser-bridged tools run
        // inside whatever branch the connected workspace has open (the bridge
        // records it, and the ownership pre-check above reads the row there).
        branch: MAIN_SCOPE,
        userId: ctx.userId,
        capabilities: ctx.capabilities,
        scope: tool.scope === 'shared' ? 'content' : tool.scope,
        conversationId: `mcp:${ctx.connectorId}`,
        snapshot: null,
      })
    } catch (err) {
      // Browser bridge rejection is terminal for a chat turn, but MCP has no
      // surrounding provider loop to terminate. Translate the same transport
      // failure into the protocol's normal tool-error result instead of
      // letting the request handler reject with an internal MCP error.
      return project({
        isError: true,
        content: [{
          type: 'text',
          text: getErrorMessage(err, `Browser tool "${tool.name}" could not return a result.`),
        }],
      })
    }

    if (!output.ok) {
      return project({
        isError: true,
        content: [{ type: 'text', text: output.error ?? 'Tool failed.' }],
      })
    }
    // A tool that mutates but returns no payload (e.g. deleteNode) must still
    // read as an unambiguous success — never the literal "null".
    const payload = output.data === undefined || output.data === null ? { ok: true } : output.data
    const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(payload) }]
    // Ship the payload as `structuredContent` too, so a client parses the
    // result instead of re-deriving its shape from the text block. Only when
    // it is an object: the 2025 wire shape requires one, and a tool returning
    // a bare array would otherwise be wrapped as `{ result: … }` and stop
    // matching its own advertised `outputSchema`.
    const structuredContent = isJsonObject(payload) ? payload : undefined
    // Forward image attachments (e.g. render_snapshot's PNG) as MCP image
    // content blocks so vision clients actually receive the screenshot — they
    // travel on `output.images`, never inlined into the text payload.
    for (const image of output.images ?? []) {
      content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
    }
    return project(structuredContent ? { content, structuredContent } : { content })
  })

  return server
}
