import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Embeds the Claude Agent SDK handler directly in the Vite dev server so
 * `bun dev` is all that's needed — no separate `bun run dev:agent` process.
 *
 * POST /api/agent is served by the same process as the HMR/asset server.
 * Auth: ambient Claude Code credentials (claude auth login) — Constraint #385.
 * No ANTHROPIC_API_KEY, no endpoint URL, no env var required.
 *
 * Production / alternative: `bun run dev:all` still works; the Bun agent
 * server on port 3001 can be used instead by restoring the proxy config.
 */
function agentDevPlugin(): Plugin {
  return {
    name: 'page-builder-agent-dev',
    apply: 'serve',

    configureServer(server) {
      // Lazily loaded on first request; cached for the life of the dev server.
      let _handler: ((req: Request) => Promise<Response>) | null = null

      const getHandler = async () => {
        if (!_handler) {
          // ssrLoadModule uses Vite's esbuild pipeline — TypeScript + aliases work.
          // External packages (like @anthropic-ai/claude-agent-sdk) are left as-is.
          const mod = await server.ssrLoadModule(
            path.resolve(__dirname, 'server/agentHandler.ts'),
          )
          _handler = mod.handleAgentRequest as (req: Request) => Promise<Response>
        }
        return _handler
      }

      // NOTE: this path must match AGENT_API_PATH in src/core/agent/agentConfig.ts
      server.middlewares.use(
        '/api/agent',
        (req: IncomingMessage, res: ServerResponse) => {
          const origin = req.headers.origin ?? null
          const corsHeaders: Record<string, string> = {
            'Access-Control-Allow-Origin': origin ?? '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          }

          // CORS preflight
          if (req.method === 'OPTIONS') {
            res.writeHead(204, corsHeaders)
            res.end()
            return
          }

          if (req.method !== 'POST') {
            res.writeHead(405, corsHeaders)
            res.end('Method not allowed')
            return
          }

          // Collect request body chunks
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(500, corsHeaders)
              res.end(JSON.stringify({ error: 'Request error' }))
            }
          })
          req.on('end', () => {
            // Deliberately NOT awaiting here — kick off async work inside
            void (async () => {
              try {
                const handler = await getHandler()
                const body = Buffer.concat(chunks)

                // Wrap Node IncomingMessage into the Web API Request that
                // handleAgentRequest expects.
                const fakeReq = new Request('http://localhost/api/agent', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body,
                })

                const response = await handler(fakeReq)

                res.writeHead(response.status, {
                  'Content-Type':
                    response.headers.get('Content-Type') ?? 'application/x-ndjson',
                  'Cache-Control': 'no-cache',
                  'X-Accel-Buffering': 'no',
                  ...corsHeaders,
                })

                if (!response.body) {
                  res.end()
                  return
                }

                // Stream NDJSON chunks back to the browser
                const reader = response.body.getReader()
                try {
                  while (true) {
                    const { done, value } = await reader.read()
                    if (done) {
                      res.end()
                      break
                    }
                    // Respect backpressure
                    if (!res.write(value)) {
                      await new Promise<void>((r) => res.once('drain', r))
                    }
                  }
                } catch {
                  if (!res.headersSent) res.writeHead(500, corsHeaders)
                  try { res.end() } catch { /* already closed */ }
                }
              } catch (err) {
                console.error('[agent-dev-plugin]', err)
                if (!res.headersSent) {
                  res.writeHead(500, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                  })
                }
                try {
                  res.end(JSON.stringify({ error: 'Internal server error' }))
                } catch { /* already ended */ }
              }
            })()
          })
        },
      )

      let _publishHandler: ((req: Request) => Promise<Response>) | null = null
      const getPublishHandler = async () => {
        if (!_publishHandler) {
          const mod = await server.ssrLoadModule(
            path.resolve(__dirname, 'server/publishHandler.ts'),
          )
          _publishHandler = mod.handlePublishRequest as (req: Request) => Promise<Response>
        }
        return _publishHandler
      }

      server.middlewares.use(
        '/api/publish',
        (req: IncomingMessage, res: ServerResponse) => {
          const origin = req.headers.origin ?? null
          const corsHeaders: Record<string, string> = {
            'Access-Control-Allow-Origin': origin ?? '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          }

          if (req.method === 'OPTIONS') {
            res.writeHead(204, corsHeaders)
            res.end()
            return
          }

          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            void (async () => {
              try {
                const handler = await getPublishHandler()
                const body = Buffer.concat(chunks)
                const publishReq = new Request(`http://localhost/api/publish${req.url === '/' ? '' : req.url ?? ''}`, {
                  method: req.method,
                  headers: { 'Content-Type': 'application/json' },
                  body: req.method === 'GET' ? undefined : body,
                })
                const response = await handler(publishReq)
                res.writeHead(response.status, {
                  'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
                  ...corsHeaders,
                })
                res.end(await response.text())
              } catch (err) {
                console.error('[publish-dev-plugin]', err)
                res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders })
                res.end(JSON.stringify({ error: 'Internal server error' }))
              }
            })()
          })
        },
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    agentDevPlugin(),
  ],
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@editor': path.resolve(__dirname, 'src/editor'),
      '@modules': path.resolve(__dirname, 'src/modules'),
      '@ui': path.resolve(__dirname, 'src/ui'),
      '@app': path.resolve(__dirname, 'src/app'),
      // @motion/icons — 2,216 icon components vendored in src/ui/icons/
      // (copied from motion.page-master/packages/icons — Constraint #348)
      '@motion/icons': path.resolve(__dirname, 'src/ui/icons'),
    },
  },
  server: {
    /**
     * Phase D — standalone dev server handles /api/agent via agentDevPlugin().
     * The proxy below is intentionally removed; the Vite plugin middleware
     * serves Claude Agent SDK requests in-process without a second server.
     *
     * If you need a separate Bun agent server (e.g., for debugging the server
     * layer in isolation), use: bun run dev:agent
     */
  },
})
