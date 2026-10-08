import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../src/__tests__/helpers/capabilityHarness'
import { createDataRow, createDataTable, getDataRow } from '../../repositories/data'
import { getDraftSiteDocument } from '../../repositories/publish'
import { saveDraftSite } from '../../repositories/site'
import type { CoreCapability } from '@core/capabilities'
import { LocalizedDataReferenceAccessError } from '@core/data/localizedCells'
import { LocalizationError } from '@core/localization'
import { authorizeMcpContentTool } from './contentAuthorization'
import { MAIN_SCOPE } from '../../branches/scope'

describe('MCP content row authorization', () => {
  let harness: CapabilityTestHarness
  let ownerId: string
  let foreignUserId: string

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    const foreign = await harness.createRoleUser({
      name: 'Foreign Author',
      slug: 'foreign-author',
      capabilities: ['content.create', 'content.edit.own', 'content.publish.own'],
    })
    const { rows: users } = await harness.db<{ id: string; email: string }>`
      select id, email from users
    `
    ownerId = users.find((user) => user.email !== foreign.email)?.id ?? ''
    foreignUserId = users.find((user) => user.email === foreign.email)?.id ?? ''
    if (!ownerId || !foreignUserId) throw new Error('test users were not seeded')
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const delegatedCapabilities: CoreCapability[] = [
    'data.custom.tables.read', 'content.create', 'content.edit.own',
  ]

  async function localizedDocuments() {
    const site = (await getDraftSiteDocument(harness.db, MAIN_SCOPE))!
    site.settings.localization = { catalogues: ['it', 'de'].map(language => ({ language, fileId: `language-${language}` })) }
    site.files = ['it', 'de'].map(language => ({
      id: `language-${language}`, path: `languages/${language}.json`, type: 'config' as const, createdAt: 0, updatedAt: 0,
      content: JSON.stringify({ language, messages: { entry: { title: 'Authorized title', caption: 'Authorized caption', secret: 'Private text' } } }),
    }))
    await saveDraftSite(harness.db, MAIN_SCOPE, site)
    const table = await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'localized-articles', name: 'Localized articles', slug: 'localized-articles', kind: 'postType',
      singularLabel: 'Article', pluralLabel: 'Articles',
      primaryFieldId: 'heading', fields: [
        { id: 'heading', label: 'Heading', type: 'localizedText' },
        { id: 'cards', label: 'Cards', type: 'repeater', fields: [{ id: 'caption', label: 'Caption', type: 'localizedText' }] },
        { id: 'literal', label: 'Literal text', type: 'text' },
      ],
    })
    const owned = await createDataRow(harness.db, MAIN_SCOPE, {
      id: 'localized-owned', tableId: table.id, slug: 'localized-owned', cells: {
        heading: { key: 'entry.title' }, cards: [{ id: 'stable-card', cells: { caption: { key: 'entry.caption' } } }],
      },
    }, ownerId)
    const foreign = await createDataRow(harness.db, MAIN_SCOPE, {
      id: 'localized-foreign', tableId: table.id, slug: 'localized-foreign', cells: { heading: { key: 'entry.secret' } },
    }, ownerId)
    await harness.db`UPDATE data_rows SET author_user_id = ${foreignUserId} WHERE id = ${foreign.id}`
    return { table, owned }
  }

  it('does not let an own-only connector borrow its owner browser\'s any-row authority', async () => {
    const foreignRow = await createDataRow(harness.db, MAIN_SCOPE, {
      id: 'foreign-document',
      tableId: 'posts',
      cells: { title: 'Foreign document' },
      slug: 'foreign-document',
    }, foreignUserId)

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['data.system.tables.read', 'content.edit.own'],
      'content_set_document_fields',
      { documentId: foreignRow.id, fields: { title: 'Not allowed' } },
      MAIN_SCOPE,
    )).rejects.toThrow('not permitted')

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['data.system.tables.read', 'content.publish.own'],
      'content_set_document_status',
      { documentId: foreignRow.id, status: 'published' },
      MAIN_SCOPE,
    )).rejects.toThrow('not permitted')
  })

  it('allows own-row grants for owned documents and any-row grants for foreign documents', async () => {
    const ownRow = await createDataRow(harness.db, MAIN_SCOPE, {
      id: 'owned-document',
      tableId: 'posts',
      cells: { title: 'Owned document' },
      slug: 'owned-document',
    }, ownerId)
    const foreignRow = await createDataRow(harness.db, MAIN_SCOPE, {
      id: 'any-document',
      tableId: 'posts',
      cells: { title: 'Any document' },
      slug: 'any-document',
    }, foreignUserId)

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['data.system.tables.read', 'content.edit.own'],
      'content_set_document_field',
      { documentId: ownRow.id, fieldId: 'title', value: 'Allowed' },
      MAIN_SCOPE,
    )).resolves.toBeUndefined()

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['data.system.tables.read', 'content.edit.any'],
      'content_delete_document',
      { documentId: foreignRow.id },
      MAIN_SCOPE,
    )).resolves.toBeUndefined()

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['data.system.tables.read', 'content.publish.any'],
      'content_set_document_status',
      { documentId: foreignRow.id, status: 'published' },
      MAIN_SCOPE,
    )).resolves.toBeUndefined()
  })

  it('denies private existing and missing keys identically before create, scalar or batch writes borrow the owner session', async () => {
    const { table, owned } = await localizedDocuments()
    for (const key of ['entry.secret', 'entry.missing']) {
      const calls = [
        { name: 'content_create_document', input: { tableId: table.id, fields: { heading: { key } } } },
        { name: 'content_set_document_field', input: { documentId: owned.id, fieldId: 'heading', value: { key } } },
        { name: 'content_set_document_fields', input: { documentId: owned.id, fields: { heading: { key } } } },
      ]
      for (const call of calls) {
        const error = await authorizeMcpContentTool(harness.db, ownerId, delegatedCapabilities, call.name, call.input, MAIN_SCOPE)
          .then(() => { throw new Error('Expected delegated-key denial') }, cause => cause)
        expect(error).toBeInstanceOf(LocalizedDataReferenceAccessError)
        expect(error.path).toBe('fields.heading')
        expect(error.message).not.toContain(key)
        expect(error.message).toBe('fields.heading: Choose a language-catalogue key authorized for this content, or request Site access to browse new keys')
      }
    }
    expect((await getDataRow(harness.db, MAIN_SCOPE, owned.id))!.cells).toEqual(owned.cells)
  })

  it('accepts authorized references including repeaters and keeps ordinary text literal', async () => {
    const { table, owned } = await localizedDocuments()
    const fields = { heading: { key: 'entry.title' }, cards: [{ id: 'new-card', cells: { caption: { key: 'entry.caption' } } }],
      literal: 'entry.secret' }
    await expect(authorizeMcpContentTool(harness.db, ownerId, delegatedCapabilities,
      'content_create_document', { tableId: table.id, fields }, MAIN_SCOPE)).resolves.toBeUndefined()
    await expect(authorizeMcpContentTool(harness.db, ownerId, delegatedCapabilities,
      'content_set_document_fields', { documentId: owned.id, fields }, MAIN_SCOPE)).resolves.toBeUndefined()
    await expect(authorizeMcpContentTool(harness.db, ownerId, delegatedCapabilities,
      'content_set_document_field', { documentId: owned.id, fieldId: 'literal', value: 'entry.missing' }, MAIN_SCOPE)).resolves.toBeUndefined()
    await expect(authorizeMcpContentTool(harness.db, ownerId, delegatedCapabilities,
      'content_set_document_field', { documentId: owned.id, fieldId: 'cards', value: [{ id: 'new-card', cells: { caption: { key: 'entry.secret' } } }] }, MAIN_SCOPE))
      .rejects.toBeInstanceOf(LocalizedDataReferenceAccessError)
  })

  it('uses only delegated table and row capabilities even when the owner has full access', async () => {
    const { table, owned } = await localizedDocuments()
    await expect(authorizeMcpContentTool(harness.db, ownerId, ['content.create'],
      'content_create_document', { tableId: table.id }, MAIN_SCOPE)).rejects.toThrow('not permitted')
    await expect(authorizeMcpContentTool(harness.db, ownerId, ['content.edit.own'],
      'content_set_document_field', { documentId: owned.id, fieldId: 'heading', value: { key: 'entry.title' } }, MAIN_SCOPE)).rejects.toThrow('not permitted')
    await expect(authorizeMcpContentTool(harness.db, ownerId, delegatedCapabilities,
      'content_set_document_fields', { documentId: 'localized-foreign', fields: { heading: { key: 'entry.title' } } }, MAIN_SCOPE)).rejects.toThrow('not permitted')
  })

  it('allows catalogue browsing only when site.read is explicitly delegated and still validates references', async () => {
    const { table } = await localizedDocuments()
    const capabilities = [...delegatedCapabilities, 'site.read'] satisfies CoreCapability[]
    await expect(authorizeMcpContentTool(harness.db, ownerId, capabilities,
      'content_create_document', { tableId: table.id, fields: { heading: { key: 'entry.secret' } } }, MAIN_SCOPE)).resolves.toBeUndefined()
    await expect(authorizeMcpContentTool(harness.db, ownerId, capabilities,
      'content_create_document', { tableId: table.id, fields: { heading: { key: 'entry.missing' } } }, MAIN_SCOPE)).rejects.toBeInstanceOf(LocalizationError)
  })
})
