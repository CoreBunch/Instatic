import { describe, expect, it, beforeEach } from 'bun:test'
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

function mcpRequest(body: string, token?: string): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return new Request('http://localhost/_instatic/mcp', { method: 'POST', headers, body })
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

  it('rejects an unauthenticated initialize with 401', async () => {
    const res = await handleMcpHttp(mcpRequest(initBody()), db)
    expect(res?.status).toBe(401)
    expect(res?.headers.get('WWW-Authenticate')).toContain('Bearer')
  })

  it('completes an initialize handshake with a valid token', async () => {
    const res = await handleMcpHttp(mcpRequest(initBody(), token), db)
    expect(res?.status).toBe(200)
    const text = await res!.text()
    expect(text).toContain('protocolVersion')
    expect(text).toContain('instatic')
  })
})
