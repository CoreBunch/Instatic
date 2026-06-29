/**
 * useEditorMcpBridge — holds the MCP "live editor bridge" open while the site
 * editor is mounted.
 *
 * External MCP clients (Claude Code, Codex, remote agents) can use the editor's
 * browser-execution tools (insert HTML, apply CSS, set tokens, manage pages,
 * content CRUD, …) only when an editor is open to run them. This hook opens the
 * long-lived NDJSON stream at `/admin/api/ai/editor-bridge`; when the server
 * relays a `toolRequest`, it runs the SAME `executeAgentTool` the agent panel
 * uses against the live store and POSTs the result back through the existing
 * tool-result endpoint (`postToolResult`).
 *
 * The stream reconnects with a fixed backoff while mounted so a transient drop
 * doesn't silently disable MCP editing.
 */
import { useEffect } from 'react'
import { Type } from '@core/utils/typeboxHelpers'
import { isAbortError } from '@core/http'
import type { AiToolOutput } from '@core/ai'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import { readNdjsonStream } from './ndjsonStream'
import { executeAgentTool } from './executor'
import { postToolResult } from './agentApi'
import { flushEditorSave } from '../hooks/editorSaveRef'

const EDITOR_BRIDGE_PATH = '/admin/api/ai/editor-bridge'
const RECONNECT_DELAY_MS = 3000
// Auth failures (logged out / brief blip during a server restart) back off
// longer but still retry — the bridge self-heals once the session is valid.
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

export function useEditorMcpBridge(): void {
  useEffect(() => {
    const controller = new AbortController()
    let stopped = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    // Returns 'auth' when the server rejected on auth (back off longer, but
    // keep retrying — a dev-server restart or brief session blip is transient
    // and must self-heal). Returns 'transient' otherwise (stream ended / not
    // ready → reconnect soon). Never permanently stops except on unmount.
    async function connectOnce(): Promise<'auth' | 'transient'> {
      let bridgeId = ''
      const res = await fetch(EDITOR_BRIDGE_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/x-ndjson' },
        signal: controller.signal,
      })
      if (res.status === 401 || res.status === 403) return 'auth'
      if (!res.ok || !res.body) return 'transient'

      for await (const event of readNdjsonStream(res.body.getReader(), BridgeEventSchema)) {
        if (stopped) break
        if (event.type === 'bridgeReady') {
          bridgeId = event.bridgeId
          console.info('[editor-mcp-bridge] connected — MCP clients can now drive this editor')
          continue
        }
        // toolRequest: run against the live editor store, then post the result.
        let result: AiToolOutput
        try {
          result = await executeAgentTool(event.toolName, event.input)
          // If the tool mutated the store, flush the draft to the DB so a
          // follow-up headless MCP read (read_styles / content reads) sees the
          // change instead of stale state.
          if (result.ok && useEditorStore.getState().hasUnsavedChanges) {
            try {
              await flushEditorSave()
            } catch (err) {
              console.error('[editor-mcp-bridge] flush save failed:', err)
            }
          }
        } catch (err) {
          result = { ok: false, error: getErrorMessage(err, 'Tool failed.') }
        }
        await postToolResult(bridgeId, event.requestId, result, controller.signal).catch(() => {})
      }
      return 'transient'
    }

    async function loop(): Promise<void> {
      while (!stopped) {
        let delay = RECONNECT_DELAY_MS
        try {
          const outcome = await connectOnce()
          if (outcome === 'auth') delay = AUTH_RETRY_DELAY_MS
        } catch (err) {
          if (isAbortError(err) || stopped) break
          console.error('[editor-mcp-bridge] stream error (will retry):', err)
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
      controller.abort()
    }
  }, [])
}
