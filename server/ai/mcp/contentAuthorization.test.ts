import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../src/__tests__/helpers/capabilityHarness'
import { createDataRow } from '../../repositories/data'
import { authorizeMcpContentTool } from './contentAuthorization'

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

  it('does not let an own-only connector borrow its owner browser\'s any-row authority', async () => {
    const foreignRow = await createDataRow(harness.db, {
      id: 'foreign-document',
      tableId: 'posts',
      cells: { title: 'Foreign document' },
      slug: 'foreign-document',
    }, foreignUserId)

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['content.edit.own'],
      'content_set_document_fields',
      { documentId: foreignRow.id, fields: { title: 'Not allowed' } },
    )).rejects.toThrow('not permitted')

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['content.publish.own'],
      'content_set_document_status',
      { documentId: foreignRow.id, status: 'published' },
    )).rejects.toThrow('not permitted')
  })

  it('allows own-row grants for owned documents and any-row grants for foreign documents', async () => {
    const ownRow = await createDataRow(harness.db, {
      id: 'owned-document',
      tableId: 'posts',
      cells: { title: 'Owned document' },
      slug: 'owned-document',
    }, ownerId)
    const foreignRow = await createDataRow(harness.db, {
      id: 'any-document',
      tableId: 'posts',
      cells: { title: 'Any document' },
      slug: 'any-document',
    }, foreignUserId)

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['content.edit.own'],
      'content_set_document_field',
      { documentId: ownRow.id, fieldId: 'title', value: 'Allowed' },
    )).resolves.toBeUndefined()

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['content.edit.any'],
      'content_delete_document',
      { documentId: foreignRow.id },
    )).resolves.toBeUndefined()

    await expect(authorizeMcpContentTool(
      harness.db,
      ownerId,
      ['content.publish.any'],
      'content_set_document_status',
      { documentId: foreignRow.id, status: 'published' },
    )).resolves.toBeUndefined()
  })
})
