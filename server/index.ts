/**
 * Phase D — Agent API server (Bun HTTP).
 *
 * Run alongside the Vite dev server:
 *   bun run server/index.ts
 *
 * Vite dev proxy (vite.config.ts) forwards /api → http://localhost:3001
 * so the browser can reach this server via the relative path /api/agent.
 * No endpoint URL or API key configuration required in the browser (Constraint #385).
 *
 * Auth: Claude Agent SDK uses ambient Claude Code credentials (claude auth login).
 * Environment:
 *   PORT  — optional, defaults to 3001
 *
 * CORS:
 *   Allows requests from http://localhost:5173 (Vite default dev port)
 *   and any VITE_ALLOWED_ORIGIN env var for staging/prod setups.
 */

import { handleAgentRequest } from './agentHandler'
import { handlePublishRequest } from './publishHandler'

const PORT = Number(process.env.PORT ?? 3001)
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  process.env.VITE_ALLOWED_ORIGIN,
].filter(Boolean) as string[]

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

Bun.serve({
  port: PORT,

  async fetch(req) {
    const origin = req.headers.get('origin')
    const cors = corsHeaders(origin)

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const url = new URL(req.url)

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      })
    }

    // Agent endpoint
    if (url.pathname === '/api/agent') {
      try {
        const res = await handleAgentRequest(req)
        // Append CORS headers to the streaming response
        for (const [k, v] of Object.entries(cors)) {
          res.headers.set(k, v)
        }
        return res
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal server error'
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        })
      }
    }

    if (url.pathname === '/api/publish' || url.pathname.startsWith('/api/publish/')) {
      try {
        const res = await handlePublishRequest(req)
        for (const [k, v] of Object.entries(cors)) {
          res.headers.set(k, v)
        }
        return res
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal server error'
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        })
      }
    }

    return new Response('Not found', { status: 404, headers: cors })
  },

  error(err) {
    console.error('[agent-server] Unhandled error:', err)
    return new Response('Internal Server Error', { status: 500 })
  },
})

console.log(`[agent-server] Listening on http://localhost:${PORT}`)
console.log('[agent-server] Auth: ambient Claude Code credentials (claude auth login)')
