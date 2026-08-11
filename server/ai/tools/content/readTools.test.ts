import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../../src/__tests__/helpers/capabilityHarness'
import { createDataTable } from '../../../repositories/data'
import { contentReadTools } from './readTools'

describe('content read tools', () => {
  let harness: CapabilityTestHarness

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('keeps collection discovery aligned with the Content workspace', async () => {
    await createDataTable(harness.db, {
      id: 'projects',
      name: 'Projects',
      slug: 'projects',
      kind: 'postType',
      routeBase: '/work',
      singularLabel: 'Project',
      pluralLabel: 'Projects',
    })
    await createDataTable(harness.db, {
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
