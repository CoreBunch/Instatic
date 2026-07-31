import { describe, expect, it, beforeEach, spyOn } from 'bun:test'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import { createBearerConnection } from '../connectors/store'
import { generatePersonalAccessToken, hashMcpSecret } from '../connectors/token'
import { handleMcpHttp } from './http'

function initBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'c', version: '0' },
    },
  })
}

function mcpRequest(
  body: string,
  token?: string,
  extraHeaders: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const req = new Request('http://localhost/_instatic/mcp', { method: 'POST', headers, body })
  // happy-dom strips browser-controlled headers such as Origin from Request
  // init, though Bun.serve receives them on real network requests.
  for (const [name, value] of Object.entries(extraHeaders)) {
    req.headers.set(name, value)
  }
  return req
}

function mcpMethodRequest(method: 'GET' | 'DELETE', token?: string): Request {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  return new Request('http://localhost/_instatic/mcp', { method, headers })
}

function parseRpcBody(text: string): {
  result?: Record<string, unknown>
  error?: { code: number; message: string }
} {
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  return JSON.parse(dataLine?.slice(6) ?? text)
}

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

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
    userId: 'u1', label: 'L',
    capabilities: ['ai.chat', 'content.manage', 'site.read'], tokenHash: await hashMcpSecret(token),
  })
})

describe('mcp http transport', () => {
  it('returns null for a non-MCP path', async () => {
    const res = await handleMcpHttp(new Request('http://localhost/admin/api/other'), db)
    expect(res).toBeNull()
  })

  it('authenticates both modern and legacy requests before protocol dispatch', async () => {
    const legacy = await handleMcpHttp(mcpRequest(initBody()), db)
    expect(legacy?.status).toBe(401)
    expect(legacy?.headers.get('WWW-Authenticate')).toContain('Bearer')

    const discoverBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 'unauthenticated-discover',
      method: 'server/discover',
      params: { _meta: MODERN_META },
    })
    const modern = await handleMcpHttp(
      mcpRequest(discoverBody, undefined, {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
      }),
      db,
    )
    expect(modern?.status).toBe(401)
    expect(modern?.headers.get('WWW-Authenticate')).toContain('Bearer')
  })

  it('rejects a browser request from an untrusted Origin before dispatch', async () => {
    const res = await handleMcpHttp(
      mcpRequest(initBody(), token, { Origin: 'https://attacker.example' }),
      db,
    )
    expect(res?.status).toBe(403)
    const body = parseRpcBody(await res!.text())
    expect(body.error?.message).toContain('Origin')
  })

  it('serves a pinned 2026-07-28 server/discover request without a session', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'discover-1',
      method: 'server/discover',
      params: { _meta: MODERN_META },
    })
    const res = await handleMcpHttp(
      mcpRequest(body, token, {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
      }),
      db,
    )

    expect(res?.status).toBe(200)
    expect(res?.headers.get('Mcp-Session-Id')).toBeNull()
    const rpc = parseRpcBody(await res!.text())
    expect(rpc.result?.supportedVersions).toContain('2026-07-28')
    expect(rpc.result?.capabilities).toEqual({ tools: {} })
  })

  it('requires matching modern per-request routing headers', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: {
        name: 'content_list_collections',
        arguments: {},
        _meta: MODERN_META,
      },
    })
    const headers = {
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'content_list_collections',
    }
    const res = await handleMcpHttp(mcpRequest(body, token, headers), db)
    expect(res?.status).toBe(200)
    expect(parseRpcBody(await res!.text()).result).toBeDefined()

    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const mismatch = await handleMcpHttp(
        mcpRequest(body, token, { ...headers, 'Mcp-Name': 'site_read_styles' }),
        db,
      )
      expect(mismatch?.status).toBe(400)
      expect(parseRpcBody(await mismatch!.text()).error?.code).toBe(-32020)
      expect(errorLog).toHaveBeenCalled()
    } finally {
      errorLog.mockRestore()
    }
  })

  it('rejects a modern revision the endpoint does not support', async () => {
    const unsupportedVersion = '2027-01-01'
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'unsupported-revision',
      method: 'server/discover',
      params: {
        _meta: {
          ...MODERN_META,
          'io.modelcontextprotocol/protocolVersion': unsupportedVersion,
        },
      },
    })
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await handleMcpHttp(
        mcpRequest(body, token, {
          'MCP-Protocol-Version': unsupportedVersion,
          'Mcp-Method': 'server/discover',
        }),
        db,
      )

      expect(res?.status).toBe(400)
      const rpc = parseRpcBody(await res!.text())
      expect(rpc.error?.code).toBe(-32022)
      expect(rpc.error?.message).toContain(unsupportedVersion)
      expect(errorLog).toHaveBeenCalled()
    } finally {
      errorLog.mockRestore()
    }
  })

  it('rejects legacy session GET and DELETE operations on the stateless endpoint', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await handleMcpHttp(mcpMethodRequest(method, token), db)
      expect(res?.status).toBe(405)
      expect(parseRpcBody(await res!.text()).error?.message).toBe('Method not allowed.')
    }
  })

  it('keeps the 2025 initialize handshake as the stateless legacy fallback', async () => {
    const res = await handleMcpHttp(mcpRequest(initBody(), token), db)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('Mcp-Session-Id')).toBeNull()
    const rpc = parseRpcBody(await res!.text())
    expect(rpc.result?.protocolVersion).toBe('2025-06-18')
    expect(rpc.result?.serverInfo).toEqual({ name: 'instatic', version: '1.0.0' })
  })
})
