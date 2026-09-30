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

  it('exposes relation targets and repeater item bindings for contextual loops', async () => {
    await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'team', name: 'Team', slug: 'team-members', kind: 'data',
      singularLabel: 'Member', pluralLabel: 'Members',
      fields: [{ id: 'role', label: 'Role', type: 'text' }],
    })
    await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'offers', name: 'Offers', slug: 'offers', kind: 'data',
      singularLabel: 'Offer', pluralLabel: 'Offers',
      fields: [
        { id: 'members', label: 'Members', type: 'relation', targetTableId: 'team', allowMultiple: true },
        { id: 'lead', label: 'Lead', type: 'relation', targetTableId: 'team', allowMultiple: false },
        { id: 'slots', label: 'Slots', type: 'repeater', itemLabelFieldId: 'weekday', fields: [
          { id: 'weekday', label: 'Weekday', type: 'text' },
          { id: 'member', label: 'Member', type: 'relation', targetTableId: 'team', allowMultiple: false },
          { id: 'photo', label: 'Photo', type: 'media', mediaKind: 'image', allowMultiple: false },
        ] },
      ],
    })
    const tool = siteReadTools.find((candidate) => candidate.name === 'site_list_loop_sources')
    if (!tool?.handler) throw new Error('site_list_loop_sources handler is missing')
    const result = await tool.handler({}, {
      db: harness.db, userId: 'owner', capabilities: ['site.read'], scope: 'site',
      branch: MAIN_SCOPE, conversationId: 'test', snapshot: null, signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      sources: expect.arrayContaining([expect.objectContaining({ id: 'entry.field' })]),
      dataTables: expect.arrayContaining([
        expect.objectContaining({ id: 'team', slug: 'team-members', fields: expect.arrayContaining([
          expect.objectContaining({ id: 'role', token: '{currentEntry.role}' }),
        ]) }),
        expect.objectContaining({ id: 'offers', fields: expect.arrayContaining([
          expect.objectContaining({ id: 'members', targetTableSlug: 'team-members', allowMultiple: true }),
          expect.objectContaining({ id: 'lead', targetTableSlug: 'team-members', allowMultiple: false }),
          expect.objectContaining({ id: 'slots', itemLabelFieldId: 'weekday', fields: [
            expect.objectContaining({ id: 'weekday', token: '{currentEntry.weekday}' }),
            expect.objectContaining({ id: 'member', targetTableSlug: 'team-members', allowMultiple: false }),
            expect.objectContaining({ id: 'photo', mediaKind: 'image', format: 'media', token: '{currentEntry.photo}' }),
          ] }),
        ]) }),
      ]),
    })
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
