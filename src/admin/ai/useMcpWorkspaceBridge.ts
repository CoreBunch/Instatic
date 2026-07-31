/**
 * Keep one workspace-scoped MCP browser bridge open while its editor is
 * mounted. Site and Content each provide their own dispatcher, so both
 * workspaces can be connected at the same time without sending a content tool
 * through the site executor (or vice versa).
 */
import { useEffect } from 'react'
import { Type } from '@core/utils/typeboxHelpers'
import type { AiToolOutput } from '@core/ai'
import { getErrorMessage } from '@core/utils/errorMessage'
import { readNdjsonStream } from './ndjsonStream'
import { postToolResult } from './toolResultApi'

const MCP_BRIDGE_PATH = '/admin/api/ai/editor-bridge'
const RECONNECT_DELAY_MS = 3000
// Auth failures (logged out / brief blip during a server restart) back off
// longer but still retry so the bridge self-heals once the session is valid.
const AUTH_RETRY_DELAY_MS = 15000

const BridgeEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('bridgeReady'), bridgeId: Type.String() }),
  Type.Object({
    type: Type.Literal('toolRequest'),
    requestId: Type.String(),
    toolName: Type.String(),
    input: Type.Unknown(),
  }),
])

export type McpWorkspaceScope = 'site' | 'content'
export type McpToolDispatcher = (
  toolName: string,
  input: unknown,
) => Promise<AiToolOutput>
export type McpAfterSuccessfulTool = () => Promise<void>

/**
 * Run one relayed tool and any workspace-specific persistence step. Keeping
 * the persistence callback inside the same try/catch is deliberate: a tool is
 * not successful until its mutation is durably saved for the MCP caller's
 * next request.
 */
export async function executeMcpBridgeRequest(
  dispatchTool: McpToolDispatcher,
  toolName: string,
  input: unknown,
  afterSuccessfulTool?: McpAfterSuccessfulTool,
): Promise<AiToolOutput> {
  try {
    const result = await dispatchTool(toolName, input)
    if (result.ok && afterSuccessfulTool) await afterSuccessfulTool()
    return result
  } catch (err) {
    return { ok: false, error: getErrorMessage(err, 'Tool failed.') }
  }
}

type McpBridgeConnectionOutcome = 'auth' | 'transient'

/**
 * Run one editor-bridge connection. Every attempt owns a fresh controller;
 * its signal is also linked to the hook lifetime so unmount still tears down
 * the current request. Leaving this function aborts the connection, which is
 * essential when tool-result delivery fails: the server waiter must reject
 * now instead of hanging until its 90-second timeout.
 */
export async function runMcpWorkspaceBridgeConnection(
  scope: McpWorkspaceScope,
  dispatchTool: McpToolDispatcher,
  afterSuccessfulTool: McpAfterSuccessfulTool | undefined,
  lifecycleSignal: AbortSignal,
): Promise<McpBridgeConnectionOutcome> {
  const connectionController = new AbortController()
  const signal = AbortSignal.any([lifecycleSignal, connectionController.signal])
  let bridgeId = ''

  try {
    const res = await fetch(`${MCP_BRIDGE_PATH}?scope=${scope}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/x-ndjson' },
      signal,
    })
    if (res.status === 401 || res.status === 403) return 'auth'
    if (!res.ok || !res.body) return 'transient'

    for await (const event of readNdjsonStream(res.body.getReader(), BridgeEventSchema)) {
      signal.throwIfAborted()
      if (event.type === 'bridgeReady') {
        bridgeId = event.bridgeId
        console.info(`[mcp-workspace-bridge:${scope}] connected`)
        continue
      }

      const result = await executeMcpBridgeRequest(
        dispatchTool,
        event.toolName,
        event.input,
        afterSuccessfulTool,
      )
      await postToolResult(bridgeId, event.requestId, result, signal)
    }
    return 'transient'
  } finally {
    connectionController.abort()
  }
}

export function useMcpWorkspaceBridge(
  scope: McpWorkspaceScope,
  dispatchTool: McpToolDispatcher,
  afterSuccessfulTool?: McpAfterSuccessfulTool,
): void {
  useEffect(() => {
    const lifecycleController = new AbortController()
    let stopped = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    // Returns 'auth' when the server rejected on auth (back off longer, but
    // keep retrying). Returns 'transient' when the stream ended or was not
    // ready. Unmount is the only permanent stop condition.
    async function connectOnce(): Promise<McpBridgeConnectionOutcome> {
      return runMcpWorkspaceBridgeConnection(
        scope,
        dispatchTool,
        afterSuccessfulTool,
        lifecycleController.signal,
      )
    }

    async function loop(): Promise<void> {
      while (!stopped) {
        let delay = RECONNECT_DELAY_MS
        try {
          const outcome = await connectOnce()
          if (outcome === 'auth') delay = AUTH_RETRY_DELAY_MS
        } catch (err) {
          if (stopped || lifecycleController.signal.aborted) break
          console.error(`[mcp-workspace-bridge:${scope}] stream error (will retry):`, err)
        }
        if (stopped) break
        await new Promise<void>((resolve) => {
          reconnectTimer = setTimeout(resolve, delay)
        })
      }
    }

    void loop()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      lifecycleController.abort()
    }
  }, [scope, dispatchTool, afterSuccessfulTool])
}
