import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../../src/__tests__/helpers/capabilityHarness'
import { createDataRow, createDataTable } from '../../../repositories/data'
import type { CoreCapability } from '@core/capabilities'
import { contentReadTools } from './readTools'
import { MAIN_SCOPE } from '../../../branches/scope'

describe('content read tools', () => {
  let harness: CapabilityTestHarness

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('keeps collection discovery aligned with the Content workspace', async () => {
    await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'projects',
      name: 'Projects',
      slug: 'projects',
      kind: 'postType',
      routeBase: '/work',
      singularLabel: 'Project',
      pluralLabel: 'Projects',
    })
    await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'people',
      name: 'People',
      slug: 'people',
      kind: 'data',
      singularLabel: 'Person',
      pluralLabel: 'People',
    })

    const tool = contentReadTools.find(
      (candidate) => candidate.name === 'content_list_collections',
    )
    if (!tool?.handler) throw new Error('content_list_collections handler is missing')

    const result = await tool.handler({}, {
      db: harness.db,
      userId: 'owner',
      capabilities: ['data.system.tables.read', 'data.custom.tables.read'],
      scope: 'content',
      branch: MAIN_SCOPE,
      conversationId: 'test',
      snapshot: null,
      signal: new AbortController().signal,
    }) as { collections: Array<{ id: string; kind: string }> }

    expect(result.collections.map((collection) => collection.id)).toEqual([
      'posts',
      'projects',
    ])
    expect(result.collections.every((collection) => collection.kind === 'postType')).toBe(true)
  })
})

/**
 * Regression for GHSA-x5cc: the read tools used to call the repositories with
 * no row-level authorization, so a connector or chat caller holding only
 * content.edit.own (plus ai.chat) could read every other user's drafts and any
 * system-table row through content_get_document / content_list_documents /
 * content_search_documents, while GET /data/rows/:id correctly answered 404.
 */
describe('content read tools honour the row-access boundary (GHSA-x5cc)', () => {
  let harness: CapabilityTestHarness
  let ownerId: string
  let authorId: string

  function toolNamed(name: string) {
    const tool = contentReadTools.find((candidate) => candidate.name === name)
    if (!tool?.handler) throw new Error(`${name} handler is missing`)
    return tool.handler
  }

  function ctxFor(userId: string, capabilities: readonly CoreCapability[]) {
    return {
      db: harness.db,
      userId,
      capabilities,
      scope: 'content' as const,
      branch: MAIN_SCOPE,
      conversationId: 'test',
      snapshot: null,
      signal: new AbortController().signal,
    }
  }

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    const author = await harness.createRoleUser({
      name: 'Own Author',
      slug: 'own-author',
      capabilities: ['ai.chat', 'content.create', 'content.edit.own', 'data.system.tables.read'],
    })
    const { rows: users } = await harness.db<{ id: string; email: string }>`select id, email from users`
    ownerId = users.find((user) => user.email !== author.email)?.id ?? ''
    authorId = users.find((user) => user.email === author.email)?.id ?? ''
    if (!ownerId || !authorId) throw new Error('test users were not seeded')
    await createDataRow(harness.db, MAIN_SCOPE, {
      id: 'owner-secret-draft',
      tableId: 'posts',
      cells: { title: 'Owner secret draft', body: 'CANARY-OWNER-DRAFT', slug: 'owner-secret-draft' },
      slug: 'owner-secret-draft',
    }, ownerId)
    await createDataRow(harness.db, MAIN_SCOPE, {
      id: 'author-own-draft',
      tableId: 'posts',
      cells: { title: 'Author own draft', body: 'mine', slug: 'author-own-draft' },
      slug: 'author-own-draft',
    }, authorId)
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('content_get_document refuses another user\'s row to an own-only caller', async () => {
    const ownOnly: CoreCapability[] = ['ai.chat', 'content.edit.own', 'data.system.tables.read']
    const foreign = await toolNamed('content_get_document')({ documentId: 'owner-secret-draft' }, ctxFor(authorId, ownOnly)) as { ok?: boolean; document?: unknown }
    expect(foreign.ok).toBe(false)
    expect(JSON.stringify(foreign)).not.toContain('CANARY-OWNER-DRAFT')

    const own = await toolNamed('content_get_document')({ documentId: 'author-own-draft' }, ctxFor(authorId, ownOnly)) as { document?: { id: string } }
    expect(own.document?.id).toBe('author-own-draft')
  })

  it('content_list_documents only lists the caller\'s own rows without any-row visibility', async () => {
    const ownOnly: CoreCapability[] = ['ai.chat', 'content.edit.own', 'data.system.tables.read']
    const listed = await toolNamed('content_list_documents')({ tableId: 'posts' }, ctxFor(authorId, ownOnly)) as { documents: Array<{ id: string }> }
    expect(listed.documents.map((d) => d.id)).toEqual(['author-own-draft'])

    const all = await toolNamed('content_list_documents')({ tableId: 'posts' }, ctxFor(ownerId, ['ai.chat', 'content.edit.any', 'data.system.tables.read'])) as { documents: Array<{ id: string }> }
    expect(all.documents.map((d) => d.id).sort()).toEqual(['author-own-draft', 'owner-secret-draft'])
  })

  it('content_search_documents does not surface another user\'s rows to an own-only caller', async () => {
    const ownOnly: CoreCapability[] = ['ai.chat', 'content.edit.own', 'data.system.tables.read']
    const found = await toolNamed('content_search_documents')({ query: 'draft' }, ctxFor(authorId, ownOnly)) as { results: Array<{ id: string }> }
    expect(found.results.map((r) => r.id)).toEqual(['author-own-draft'])
  })

  it('hides system-table rows entirely from a caller without data.system.tables.read', async () => {
    const noSystem: CoreCapability[] = ['ai.chat', 'content.edit.any', 'data.custom.tables.read']
    const get = await toolNamed('content_get_document')({ documentId: 'author-own-draft' }, ctxFor(ownerId, noSystem)) as { ok?: boolean }
    expect(get.ok).toBe(false)
    const list = await toolNamed('content_list_documents')({ tableId: 'posts' }, ctxFor(ownerId, noSystem)) as { ok?: boolean; documents?: unknown[] }
    expect(list.ok).toBe(false)
    expect(list.documents).toBeUndefined()
    const search = await toolNamed('content_search_documents')({ query: 'draft' }, ctxFor(ownerId, noSystem)) as { results: unknown[] }
    expect(search.results).toEqual([])
  })
})
