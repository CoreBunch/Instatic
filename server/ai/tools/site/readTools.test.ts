import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../../src/__tests__/helpers/capabilityHarness'
import { createDataTable } from '../../../repositories/data'
import { siteReadTools } from './readTools'
import { MAIN_SCOPE } from '../../../branches/scope'

describe('site read tools', () => {
  let harness: CapabilityTestHarness

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('lists only routable post types as template targets', async () => {
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
      routeBase: '/people',
      singularLabel: 'Person',
      pluralLabel: 'People',
    })

    const tool = siteReadTools.find((candidate) => candidate.name === 'site_list_post_types')
    if (!tool?.handler) throw new Error('site_list_post_types handler is missing')

    const result = await tool.handler({}, {
      db: harness.db,
      userId: 'owner',
      capabilities: ['site.read'],
      scope: 'site',
      branch: MAIN_SCOPE,
      conversationId: 'test',
      snapshot: null,
      signal: new AbortController().signal,
    })

    expect(result).toEqual({
      postTypes: [
        {
          slug: 'posts',
          label: 'Posts',
          routeBase: '/posts',
          kind: 'postType',
        },
        {
          slug: 'projects',
          label: 'Projects',
          routeBase: '/work',
          kind: 'postType',
        },
      ],
    })
  })
})
