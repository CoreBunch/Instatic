/**
 * End-to-end MCP flow over the real HTTP handler, exercised as the sequence a
 * detached client (Claude Code / Codex) actually performs: a stateless series
 * of independent POSTs — initialize, then tools/list, then tools/call — each
 * authenticated by the connector bearer token, with NO session continuity.
 *
 * This drives `handleMcpHttp` directly (the same function the router mounts)
 * rather than a socket client, so it is deterministic under the test harness's
 * jsdom preload. Bad-token rejection is covered by `auth.test.ts` and
 * `transports/http.test.ts`.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { handleMcpHttp } from './index'
import { createBearerConnection } from './connectors/store'
import { generatePersonalAccessToken, hashMcpSecret } from './connectors/token'

let db: DbClient
let token: string

beforeEach(async () => {
  db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  token = generatePersonalAccessToken()
  await createBearerConnection(db, {
    userId: 'u1', label: 'Claude Code',
    capabilities: ['ai.chat', 'ai.tools.write', 'site.read', 'site.structure.edit', 'content.manage', 'data.system.tables.read'],
    tokenHash: await hashMcpSecret(token),
  })
})

interface RpcResponse {
  result?: {
    serverInfo?: { name: string }
    tools?: Array<{ name: string }>
    isError?: boolean
    content?: unknown
  }
  error?: { message: string }
}

let nextId = 1
async function rpc(method: string, params: unknown): Promise<{ status: number; json: RpcResponse }> {
  const req = new Request('http://localhost/_instatic/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  const res = await handleMcpHttp(req, db)
  if (!res) throw new Error('handler returned null')
  const text = await res.text()
  // `enableJsonResponse` returns a plain JSON body; tolerate an SSE `data:` prefix.
  const payload = text.startsWith('data:') ? text.slice(text.indexOf('{')) : text
  const json: RpcResponse = JSON.parse(payload)
  return { status: res.status, json }
}

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'e2e', version: '0' },
}

describe('MCP end-to-end (stateless multi-request, real handler)', () => {
  it('initializes, lists tools, and runs a headless read — the Claude Code flow', async () => {
    const init = await rpc('initialize', INIT_PARAMS)
    expect(init.status).toBe(200)
    expect(init.json.result?.serverInfo?.name).toBe('instatic')

    const list = await rpc('tools/list', {})
    const names = (list.json.result?.tools ?? []).map((t) => t.name)
    expect(names).toContain('content_list_collections') // headless content read
    expect(names).toContain('site_read_styles') // headless design-system read
    expect(names).toContain('site_insert_html') // browser editing tool, relayed to the editor

    const read = await rpc('tools/call', { name: 'content_list_collections', arguments: {} })
    expect(read.json.result?.isError).toBeFalsy()
    expect(JSON.stringify(read.json.result?.content)).toContain('pages')
  })

  it('a read-only connector sees reads but no write tools', async () => {
    const readToken = generatePersonalAccessToken()
    await createBearerConnection(db, {
      userId: 'u1', label: 'RO',
      capabilities: ['ai.chat', 'site.read', 'content.manage', 'data.system.tables.read'],
      tokenHash: await hashMcpSecret(readToken),
    })
    const req = (method: string, params: unknown) =>
      new Request('http://localhost/_instatic/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${readToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      })
    await handleMcpHttp(req('initialize', INIT_PARAMS), db)
    const listRes = await handleMcpHttp(req('tools/list', {}), db)
    const body: RpcResponse = JSON.parse(await listRes!.text())
    const tools = body.result?.tools ?? []
    const names = tools.map((t) => t.name)
    expect(names).toContain('content_list_collections')
    expect(names).toContain('site_read_styles')
    expect(names).not.toContain('site_insert_html') // write tool gated out (no ai.tools.write)
    expect(names).not.toContain('mutate_page_tree') // removed entirely
  })
})
