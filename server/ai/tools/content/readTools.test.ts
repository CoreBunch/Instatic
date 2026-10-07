import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
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

    const schema = tool.outputSchema
    expect(schema).toBeTruthy()
    expect(Value.Check(schema!, result)).toBe(true)
  })

  it('says the document reads accept a reusable data table too', () => {
    // data_* can write rows but not read them back; these two are the read
    // path, and an agent only finds that out from the description.
    const list = contentReadTools.find((t) => t.name === 'content_list_documents')
    const get = contentReadTools.find((t) => t.name === 'content_get_document')
    expect(list?.description).toContain('reusable data table')
    expect(get?.description).toContain('reusable data table')
  })
})
