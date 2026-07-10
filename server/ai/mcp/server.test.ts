import { describe, expect, it, beforeEach } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { createDataRow } from '../../repositories/data'
import { resolveBridgeToolResult } from '../runtime'
import { buildMcpServer } from './server'
import { createEditorBridgeStream } from './editorBridge'

const decoder = new TextDecoder()

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: { type: string; [key: string]: unknown }) => boolean,
): Promise<{ type: string; [key: string]: unknown }> {
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) throw new Error('stream ended before predicate matched')
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const event = JSON.parse(trimmed)
      if (predicate(event)) return event
    }
  }
}

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  return db
}

async function connectClient(
  db: DbClient,
  capabilities: Parameters<typeof buildMcpServer>[0]['capabilities'],
  userId = 'u1',
) {
  const server = buildMcpServer({ db, userId, connectorId: 'c1', capabilities })
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
    expect(text).toContain('Site editor')
    await client.close()
  })

  it('routes Site and Content browser tools to their matching workspace bridges', async () => {
    const userId = 'u1-scoped-workspaces'
    const siteCtrl = new AbortController()
    const contentCtrl = new AbortController()
    const siteReader = createEditorBridgeStream(userId, 'site', siteCtrl.signal).getReader()
    const contentReader = createEditorBridgeStream(userId, 'content', contentCtrl.signal).getReader()
    const [siteReady, contentReady] = await Promise.all([
      readUntil(siteReader, (event) => event.type === 'bridgeReady'),
      readUntil(contentReader, (event) => event.type === 'bridgeReady'),
    ])

    const client = await connectClient(
      db,
      [
        'ai.chat',
        'ai.tools.write',
        'site.structure.edit',
        'content.create',
      ],
      userId,
    )

    const siteCall = client.callTool({
      name: 'site_insert_html',
      arguments: { parentId: 'root', html: '<p>site</p>' },
    })
    const siteRequest = await readUntil(siteReader, (event) => event.type === 'toolRequest')
    expect(siteRequest.toolName).toBe('site_insert_html')
    resolveBridgeToolResult(siteReady.bridgeId as string, siteRequest.requestId as string, {
      ok: true,
      data: { inserted: 1 },
    })
    expect((await siteCall).isError).toBeFalsy()

    const contentCall = client.callTool({
      name: 'content_create_document',
      arguments: { tableId: 'posts' },
    })
    const contentRequest = await readUntil(contentReader, (event) => event.type === 'toolRequest')
    expect(contentRequest.toolName).toBe('content_create_document')
    resolveBridgeToolResult(contentReady.bridgeId as string, contentRequest.requestId as string, {
      ok: true,
      data: { documentId: 'doc-1' },
    })
    expect((await contentCall).isError).toBeFalsy()

    await client.close()
    siteCtrl.abort()
    contentCtrl.abort()
    await Promise.all([
      siteReader.read().catch(() => {}),
      contentReader.read().catch(() => {}),
    ])
  })

  it('enforces an own-only connector grant before relaying through a full-power owner browser', async () => {
    await db`
      insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('u2', 'u2@example.com', 'u2@example.com', 'User Two', 'x', 'admin')
    `
    const foreignRow = await createDataRow(db, {
      id: 'foreign-row',
      tableId: 'posts',
      cells: { title: 'Foreign row' },
      slug: 'foreign-row',
    }, 'u2')

    const ctrl = new AbortController()
    const reader = createEditorBridgeStream('u1', 'content', ctrl.signal).getReader()
    const ready = await readUntil(reader, (event) => event.type === 'bridgeReady')
    const client = await connectClient(db, [
      'ai.chat',
      'ai.tools.write',
      'content.edit.own',
    ])
    const call = client.callTool({
      name: 'content_set_document_fields',
      arguments: { documentId: foreignRow.id, fields: { title: 'Not allowed' } },
    })
    const outcome = await Promise.race([
      call.then((result) => ({ kind: 'result' as const, result })),
      readUntil(reader, (event) => event.type === 'toolRequest')
        .then((event) => ({ kind: 'relayed' as const, event })),
    ])

    // If the call was incorrectly relayed, settle it before failing so the
    // test leaves no pending bridge waiter behind.
    if (outcome.kind === 'relayed') {
      resolveBridgeToolResult(ready.bridgeId as string, outcome.event.requestId as string, {
        ok: true,
      })
      await call
    }
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') {
      expect(outcome.result.isError).toBe(true)
      expect(JSON.stringify(outcome.result.content)).toContain('not permitted')
    }

    await client.close()
    ctrl.abort()
    await reader.read().catch(() => {})
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
