import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../../src/__tests__/helpers/capabilityHarness'
import { createDataTable } from '../../../repositories/data'
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

  it('exposes writable relation and repeater item schemas', async () => {
    await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'offers', name: 'Offers', slug: 'offers', kind: 'postType', routeBase: '/offers',
      singularLabel: 'Offer', pluralLabel: 'Offers',
      fields: [
        { id: 'members', label: 'Members', type: 'relation', targetTableId: 'posts', allowMultiple: true },
        { id: 'slots', label: 'Slots', type: 'repeater', itemLabelFieldId: 'weekday', fields: [
          { id: 'weekday', label: 'Weekday', type: 'select', options: [{ id: 'mon', label: 'Monday', value: 'monday' }] },
          { id: 'member', label: 'Member', type: 'relation', targetTableId: 'posts' },
        ] },
      ],
    })
    const tool = contentReadTools.find((candidate) => candidate.name === 'content_get_collection_schema')
    if (!tool?.handler) throw new Error('content_get_collection_schema handler is missing')
    const result = await tool.handler({ tableId: 'offers' }, {
      db: harness.db, userId: 'owner', capabilities: ['data.custom.tables.read'], scope: 'content',
      branch: MAIN_SCOPE, conversationId: 'test', snapshot: null, signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ collection: { fields: expect.arrayContaining([
      expect.objectContaining({ id: 'members', targetTableId: 'posts', allowMultiple: true }),
      expect.objectContaining({ id: 'slots', itemLabelFieldId: 'weekday', fields: [
        expect.objectContaining({ id: 'weekday', options: [{ value: 'mon', label: 'Monday' }] }),
        expect.objectContaining({ id: 'member', targetTableId: 'posts', allowMultiple: false }),
      ] }),
    ]) } })
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
