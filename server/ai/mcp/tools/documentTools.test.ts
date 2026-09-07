import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import type { ToolContext } from '../../runtime/types'
import { mcpToolsForCapabilities } from '../registry'
import { createDataRow, getDataRow, saveDataRowDraft } from '../../../repositories/data'
import { createLocale } from '../../../repositories/localization'

const PAGE_TREE = {
  rootNodeId: 'root',
  nodes: {
    root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: [] },
  },
}

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  // The default site shell row is created at first-run setup, not by migrations.
  await db`
    insert into site (id, name, settings_json)
    values ('default', 'Test', ${{ cmsSiteSchemaVersion: 1, site: {} }})
  `
  // Seed one page row into the (already-seeded) `pages` system table.
  await createDataRow(db, { id: 'home', tableId: 'pages', cells: { title: 'Home', slug: 'index', body: PAGE_TREE }, slug: 'index' })
  return db
}

function headlessCtx(db: DbClient): ToolContext {
  return {
    db,
    userId: 'u1',
    capabilities: ['site.read'],
    scope: 'site',
    conversationId: 'mcp:test',
    snapshot: null, // MCP has no browser-posted snapshot — this is the crash case.
    signal: new AbortController().signal,
  }
}

describe('mcp site_list_documents (headless)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = await freshDb()
  })

  it('the MCP registry exposes a server-resolved site_list_documents that does not need a snapshot', async () => {
    const tool = mcpToolsForCapabilities(['site.read']).find((t) => t.name === 'site_list_documents')
    if (!tool?.handler) throw new Error('Expected site_list_documents handler')
    expect(tool.execution).toBe('server')

    // The site-scope (chat) version throws on `null.currentDocument`; the headless
    // one resolves the catalog from the DB. Over MCP this must not throw.
    const result = (await tool.handler({}, headlessCtx(db))) as {
      currentDocument: unknown
      documents: {
        document: { type: string; id: string }
        slug?: string
        active: boolean
        current: boolean
      }[]
    }

    expect(Array.isArray(result.documents)).toBe(true)
    expect(result.documents.some((d) => d.slug === 'index')).toBe(true)
    // No open-editor focus server-side, so nothing is reported as current.
    expect(result.currentDocument).toBeNull()
    expect(result.documents.every((document) => !document.active && !document.current)).toBe(true)
  })

  it('does not expose the catalog to an edit-only connector without site.read', () => {
    const tool = mcpToolsForCapabilities(['pages.edit']).find(
      (candidate) => candidate.name === 'site_list_documents',
    )
    expect(tool).toBeUndefined()
  })

  it('reads the requested language without requiring a browser workspace', async () => {
    const locale = await createLocale(db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', enabled: true, direction: 'ltr' })
    const source = await getDataRow(db, 'home')
    await saveDataRowDraft(db, 'home', { localeId: locale.id, cells: { ...source!.cells, title: 'Startseite', slug: 'start' }, slug: 'start' })
    const tool = mcpToolsForCapabilities(['site.read']).find((candidate) => candidate.name === 'site_list_documents')!
    const result = await tool.handler!({ localeId: locale.id }, headlessCtx(db))
    expect(result).toMatchObject({ localeId: locale.id, documents: [{ title: 'Startseite', slug: 'start' }] })
    const sourceResult = await tool.handler!({}, headlessCtx(db))
    expect(sourceResult).toMatchObject({ documents: [{ title: 'Home', slug: 'index' }] })
  })
})
