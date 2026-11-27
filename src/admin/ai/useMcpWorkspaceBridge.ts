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
import { apiRequest, withAmbientHeaders } from '@core/http'
import { readNdjsonStream } from './ndjsonStream'
import { postToolResult } from './toolResultApi'

const MCP_BRIDGE_PATH = '/admin/api/ai/editor-bridge'
const RECONNECT_DELAY_MS = 3000
// Auth failures (logged out / brief blip during a server restart) back off
// longer but still retry so the bridge self-heals once the session is valid.
const AUTH_RETRY_DELAY_MS = 15000
const STANDBY_RETRY_DELAY_MS = 15_000
// Retry a previously healthy connection immediately, even in hidden tabs
// where browsers throttle timers. Short failures still back off.
const HEALTHY_STREAM_MIN_UPTIME_MS = 30_000

const RenewalAckSchema = Type.Object({ ok: Type.Literal(true) })
const BridgeEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('bridgePing') }),
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

type McpBridgeConnectionOutcome = 'auth' | 'transient' | 'occupied'

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
    const path = `${MCP_BRIDGE_PATH}?scope=${scope}`
    const res = await fetch(path, withAmbientHeaders({
      method: 'GET',
      credentials: 'same-origin',
      // The bridge body stays newline-delimited JSON, but the event-stream
      // media type prevents reverse proxies from buffering the open response.
      headers: { Accept: 'text/event-stream' },
      signal,
    }))
    if (res.status === 204) return 'occupied'
    if (res.status === 401 || res.status === 403) return 'auth'
    if (!res.ok || !res.body) return 'transient'

    for await (const event of readNdjsonStream(res.body.getReader(), BridgeEventSchema)) {
      signal.throwIfAborted()
      if (event.type === 'bridgeReady') {
        bridgeId = event.bridgeId
        console.info(`[mcp-workspace-bridge:${scope}] connected`)
        continue
      }

      if (event.type === 'bridgePing') {
        await apiRequest(path, { method: 'POST', body: { bridgeId }, schema: RenewalAckSchema, signal })
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
  enabled = true,
): void {
  useEffect(() => {
    // A mounted route is not necessarily a usable workspace yet. In
    // particular, SitePage paints its shell before usePersistence has loaded
    // the SiteDocument into the editor store. Registering during that window
    // makes get_context report siteConnected=true even though every browser
    // runner sees store.site === null. Keep the server-side presence signal
    // aligned with actual dispatcher readiness.
    if (!enabled) return undefined

    const lifecycleController = new AbortController()
    let stopped = false

    /**
     * Delay the next attempt — but let the tab becoming visible cut the wait
     * short. In a hidden webview the timer itself is throttled (possibly to
     * minutes); the visibilitychange event fires the moment the user looks
     * again, so a stale bridge recovers instantly on focus instead of
     * waiting out a clamped timer.
     */
    function reconnectDelay(delay: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const settle = (): void => {
          clearTimeout(timer)
          lifecycleController.signal.removeEventListener('abort', settle)
          document.removeEventListener('visibilitychange', onVisible)
          resolve()
        }
        const onVisible = (): void => {
          if (document.visibilityState === 'visible') settle()
        }
        const timer = setTimeout(settle, delay)
        lifecycleController.signal.addEventListener('abort', settle, { once: true })
        document.addEventListener('visibilitychange', onVisible)
      })
    }

    async function loop(): Promise<void> {
      while (!stopped) {
        const startedAt = Date.now()
        let delay = RECONNECT_DELAY_MS
        try {
          const outcome = await runMcpWorkspaceBridgeConnection(
            scope, dispatchTool, afterSuccessfulTool, lifecycleController.signal,
          )
          if (outcome === 'auth') delay = AUTH_RETRY_DELAY_MS
          else if (outcome === 'occupied') delay = STANDBY_RETRY_DELAY_MS
          else if (Date.now() - startedAt >= HEALTHY_STREAM_MIN_UPTIME_MS) {
            delay = 0
          }
        } catch (err) {
          if (stopped || lifecycleController.signal.aborted) break
          console.error(`[mcp-workspace-bridge:${scope}] stream error (will retry):`, err)
        }
        if (stopped) break
        if (delay > 0) await reconnectDelay(delay)
      }
    }

    void loop()

    return () => {
      stopped = true
      lifecycleController.abort()
    }
  }, [scope, dispatchTool, afterSuccessfulTool, enabled])
}
