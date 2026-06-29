/**
 * Proves a browser tool's image attachment (e.g. render_snapshot's PNG) is
 * forwarded to the MCP client as an image content block — not dropped. The
 * editor bridge relays the tool to the (simulated) open editor, which returns
 * an AiToolOutput carrying `images`; the MCP server must surface them.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { resolveBridgeToolResult } from '../runtime'
import { buildMcpServer } from './server'
import { createEditorBridgeStream } from './editorBridge'

const dec = new TextDecoder()
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (e: { type: string; [k: string]: unknown }) => boolean,
): Promise<{ type: string; [k: string]: unknown }> {
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) throw new Error('stream ended')
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      const e = JSON.parse(t)
      if (predicate(e)) return e
    }
  }
}

let db: DbClient
beforeEach(async () => {
  db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
})

describe('MCP image forwarding', () => {
  it('forwards render_snapshot PNG as an MCP image content block', async () => {
    // Simulate the open editor: register its bridge stream for u1.
    const ctrl = new AbortController()
    const reader = createEditorBridgeStream('u1', ctrl.signal).getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    const server = buildMcpServer({
      db, userId: 'u1', connectorId: 'c1',
      capabilities: ['ai.chat', 'ai.tools.write', 'site.read', 'site.structure.edit'],
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'e2e', version: '0' })
    await client.connect(clientT)

    // Fire the tool call and, concurrently, play the editor: read the relayed
    // request and post back a result carrying an image.
    const callPromise = client.callTool({ name: 'site_render_snapshot', arguments: { breakpointId: 'desktop' } })

    const toolRequest = await readUntil(reader, (e) => e.type === 'toolRequest')
    expect(toolRequest.toolName).toBe('site_render_snapshot')
    resolveBridgeToolResult(bridgeId, toolRequest.requestId as string, {
      ok: true,
      data: { screenshot: { status: 'ok', width: 1, height: 1 } },
      images: [{ mimeType: 'image/png', data: PNG_B64 }],
    })

    const result = await callPromise
    const content = result.content as Array<{ type: string; data?: string; mimeType?: string }>
    const image = content.find((c) => c.type === 'image')
    expect(image).toBeTruthy()
    expect(image!.data).toBe(PNG_B64)
    expect(image!.mimeType).toBe('image/png')

    await client.close()
    ctrl.abort()
    await reader.read().catch(() => {})
  })
})
