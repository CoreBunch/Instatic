/**
 * Keep one workspace-scoped MCP browser bridge open while its editor is
 * mounted. Site and Content each provide their own dispatcher, so both
 * workspaces can be connected at the same time without sending a content tool
 * through the site executor (or vice versa).
 */
import { useEffect } from 'react'
import { Type } from '@core/utils/typeboxHelpers'
import { MCP_BRIDGE_PING_TOOL, type AiToolOutput } from '@core/ai'
import { getErrorMessage } from '@core/utils/errorMessage'
import { readNdjsonStream } from './ndjsonStream'
import { postToolResult } from './toolResultApi'

const MCP_BRIDGE_PATH = '/admin/api/ai/editor-bridge'
const RECONNECT_DELAY_MS = 3000
/**
 * Longest one relayed tool (plus its persistence step) may run before the
 * loop gives up on it and moves on. Requests are serviced serially, so a tool
 * whose promise never settled used to block every later request on the stream
 * until the tab reloaded (#490). Kept under the relay's 90 s per-call timeout
 * (`server/ai/runtime/transport.ts`) so the caller reads this diagnosis rather
 * than a bare timeout, and so the result POST still finds its waiter.
 */
const BROWSER_TOOL_DEADLINE_MS = 60_000
// Auth failures (logged out / brief blip during a server restart) back off
// longer but still retry so the bridge self-heals once the session is valid.
const AUTH_RETRY_DELAY_MS = 15000
// A stream that lived at least this long ended because the server recycled
// its idle lease, not because anything is wrong — reconnect immediately.
// This matters in background/hidden webviews (a browser tab in the
// background, a minimized window): timers there are throttled to minutes, but the
// stream-end network event still fires, so a timerless reconnect is what
// keeps the bridge alive without the window being focused.
const HEALTHY_STREAM_MIN_UPTIME_MS = 30_000

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
 * Run one relayed tool and any workspace-specific persistence step, bounded
 * by `deadlineMs`. Keeping the persistence callback inside the same try/catch
 * is deliberate: a tool is not successful until its mutation is durably saved
 * for the MCP caller's next request. Past the deadline the caller gets an
 * error naming the tool and the loop is free again; the tool itself cannot be
 * cancelled and may still finish in the background, which the error says.
 */
export async function executeMcpBridgeRequest(
  dispatchTool: McpToolDispatcher,
  toolName: string,
  input: unknown,
  afterSuccessfulTool?: McpAfterSuccessfulTool,
  deadlineMs: number = BROWSER_TOOL_DEADLINE_MS,
): Promise<AiToolOutput> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<AiToolOutput>((resolve) => {
    deadline = setTimeout(() => {
      resolve({
        ok: false,
        error:
          `Browser tool "${toolName}" did not finish within ${Math.round(deadlineMs / 1000)}s. `
          + 'The editor may still complete it in the background, so read the document before '
          + 'retrying; if later calls keep failing, reload the workspace tab.',
      })
    }, deadlineMs)
  })
  const run = (async (): Promise<AiToolOutput> => {
    try {
      const result = await dispatchTool(toolName, input)
      if (result.ok && afterSuccessfulTool) await afterSuccessfulTool()
      return result
    } catch (err) {
      return { ok: false, error: getErrorMessage(err, 'Tool failed.') }
    }
  })()
  try {
    return await Promise.race([run, expired])
  } finally {
    clearTimeout(deadline)
  }
}

type McpBridgeConnectionOutcome = 'auth' | 'transient'

interface McpBridgeConnectionOptions {
  /** Test seam: the per-tool deadline shrinks to milliseconds in unit tests. */
  toolDeadlineMs?: number
}

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
  options: McpBridgeConnectionOptions = {},
): Promise<McpBridgeConnectionOutcome> {
  const connectionController = new AbortController()
  const signal = AbortSignal.any([lifecycleSignal, connectionController.signal])
  let bridgeId = ''

  try {
    const res = await fetch(`${MCP_BRIDGE_PATH}?scope=${scope}`, {
      method: 'GET',
      credentials: 'same-origin',
      // The bridge body stays newline-delimited JSON, but the event-stream
      // media type prevents reverse proxies from buffering the open response.
      headers: { Accept: 'text/event-stream' },
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

      if (event.toolName === MCP_BRIDGE_PING_TOOL) {
        // Liveness probe from get_context. Answered here, by the loop itself:
        // a reply proves the stream AND this request loop are servicing calls,
        // which is what "connected" has to mean. It never reaches the
        // workspace dispatcher.
        await postToolResult(bridgeId, event.requestId, { ok: true, data: { alive: true } }, signal)
        continue
      }

      const result = await executeMcpBridgeRequest(
        dispatchTool,
        event.toolName,
        event.input,
        afterSuccessfulTool,
        options.toolDeadlineMs,
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
          if (reconnectTimer) clearTimeout(reconnectTimer)
          reconnectTimer = null
          document.removeEventListener('visibilitychange', onVisible)
          resolve()
        }
        const onVisible = (): void => {
          if (document.visibilityState === 'visible') settle()
        }
        reconnectTimer = setTimeout(settle, delay)
        document.addEventListener('visibilitychange', onVisible)
      })
    }

    async function loop(): Promise<void> {
      while (!stopped) {
        const startedAt = Date.now()
        let delay = RECONNECT_DELAY_MS
        try {
          const outcome = await connectOnce()
          if (outcome === 'auth') delay = AUTH_RETRY_DELAY_MS
          else if (Date.now() - startedAt >= HEALTHY_STREAM_MIN_UPTIME_MS) {
            // The server recycled a healthy stream's idle lease — go
            // straight back, no timer involved (see the constant's note).
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
      if (reconnectTimer) clearTimeout(reconnectTimer)
      lifecycleController.abort()
    }
  }, [scope, dispatchTool, afterSuccessfulTool, enabled])
}
