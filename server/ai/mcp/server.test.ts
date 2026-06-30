import { describe, expect, it, beforeEach } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { buildMcpServer } from './server'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  return db
}

async function connectClient(db: DbClient, capabilities: Parameters<typeof buildMcpServer>[0]['capabilities']) {
  const server = buildMcpServer({ db, userId: 'u1', connectorId: 'c1', capabilities })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientT)
  return client
}

let db: DbClient
beforeEach(async () => { db = await freshDb() })

describe('mcp server', () => {
  it('lists tools filtered by capability (no write tools without ai.tools.write)', async () => {
    // Read-only: site + data + content reads, but NO ai.tools.write.
    const client = await connectClient(db, ['ai.chat', 'content.manage', 'site.read', 'data.system.tables.read'])
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('content_list_collections') // headless read
    expect(names).toContain('site_read_styles') // headless design-system read
    // Write tools are gated out (MCP Tool exposes no `mutates` flag, so assert by name).
    expect(names).not.toContain('site_insert_html')
    expect(names).not.toContain('site_delete_node')
    expect(names).not.toContain('site_apply_css')
    await client.close()
  })

  it('runs a headless content read tool', async () => {
    const client = await connectClient(db, ['ai.chat', 'site.read', 'data.system.tables.read'])
    const result = await client.callTool({ name: 'content_list_collections', arguments: {} })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('pages') // the seeded system table
    await client.close()
  })

  it('lists browser editing tools but errors with an open-editor hint when no editor is connected', async () => {
    const client = await connectClient(db, ['ai.chat', 'ai.tools.write', 'site.structure.edit', 'content.manage'])
    const { tools } = await client.listTools()
    expect(tools.some((t) => t.name === 'site_insert_html')).toBe(true) // browser tool is listed
    expect(tools.some((t) => t.name === 'site_delete_node')).toBe(true)

    const result = await client.callTool({ name: 'site_insert_html', arguments: { html: '<p>hi</p>' } })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('Instatic editor')
    await client.close()
  })

  it('does not expose the removed headless page-tree tools', async () => {
    const client = await connectClient(db, ['ai.chat', 'ai.tools.write', 'site.structure.edit', 'content.manage'])
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('read_page_tree')
    expect(names).not.toContain('mutate_page_tree')
    await client.close()
  })
})
