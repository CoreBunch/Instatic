/**
 * Regression test for #677: restoring a page version restores the page tree (body)
 * from the published snapshot, instead of dropping it to { title, slug }, and preserves
 * unversioned/custom fields.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { getDataRow, listDataRows, saveDataRowDraft } from '../../../server/repositories/data'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const ROWS = '/admin/api/cms/data/rows'

describe('page version restore', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  it('restores the page tree of the chosen version and keeps unversioned fields', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    expect(home).toBeDefined()
    expect(home!.cells.body).toBeTruthy()

    // 1. Save and publish v1 with a distinct page tree in body.
    const v1Body = {
      nodes: {
        root: {
          id: 'root',
          moduleId: 'base.body',
          children: ['node-1'],
          props: {},
          breakpointOverrides: {},
          classIds: [],
        },
        'node-1': {
          id: 'node-1',
          moduleId: 'base.heading',
          children: [],
          props: { text: 'Heading V1' },
          breakpointOverrides: {},
          classIds: [],
        },
      },
      rootNodeId: 'root',
    }
    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, {
      cells: { ...home!.cells, title: 'First Version', body: v1Body },
      slug: home!.slug,
    })
    await publishDraftSite(harness.db, (await getDataRow(harness.db, MAIN_SCOPE, home!.id))!.createdByUserId!)

    // 2. Save and publish v2 with a different page tree and an unversioned field (seoTitle).
    const v2Body = {
      nodes: {
        root: {
          id: 'root',
          moduleId: 'base.body',
          children: ['node-2'],
          props: {},
          breakpointOverrides: {},
          classIds: [],
        },
        'node-2': {
          id: 'node-2',
          moduleId: 'base.heading',
          children: [],
          props: { text: 'Heading V2' },
          breakpointOverrides: {},
          classIds: [],
        },
      },
      rootNodeId: 'root',
    }
    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, {
      cells: {
        ...home!.cells,
        title: 'Second Version',
        body: v2Body,
        seoTitle: 'Authored SEO Title',
        customMeta: 'Custom Meta Value',
      },
      slug: home!.slug,
    })
    const pubRes = await harness.cms(`${ROWS}/${home!.id}/publish`, { method: 'POST', cookie: owner })
    expect(pubRes.status).toBe(200)

    // 3. List versions and find v1.
    const listed = await readJson<{ versions: Array<{ id: string; versionNumber: number }> }>(
      await harness.cms(`${ROWS}/${home!.id}/versions`, { cookie: owner }),
    )
    expect(listed.versions.map((v) => v.versionNumber)).toEqual([2, 1])
    const v1 = listed.versions.find((v) => v.versionNumber === 1)!
    expect(v1).toBeDefined()

    // 4. Restore v1 into the draft.
    const restored = await harness.cms(`${ROWS}/${home!.id}/versions/${v1.id}/restore`, {
      method: 'POST',
      cookie: owner,
    })
    expect(restored.status).toBe(200)

    // 5. Verify the restored draft has v1's title and body, and keeps unversioned fields.
    const currentDraft = await getDataRow(harness.db, MAIN_SCOPE, home!.id)
    expect(currentDraft).toBeTruthy()
    expect(currentDraft!.cells.title).toBe('First Version')
    expect(currentDraft!.cells.body).toEqual(v1Body)
    expect(currentDraft!.cells.seoTitle).toBe('Authored SEO Title')
    expect(currentDraft!.cells.customMeta).toBe('Custom Meta Value')
  })

  it('restores template settings when restoring a page version', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    expect(home).toBeDefined()

    // 1. Publish v1 with template enabled.
    const templateConfig = { kind: 'postTypes', tableSlugs: ['posts'] }
    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, {
      cells: {
        ...home!.cells,
        title: 'Template Page V1',
        templateEnabled: true,
        templateTarget: templateConfig,
        templatePriority: 5,
      },
      slug: home!.slug,
    })
    await publishDraftSite(harness.db, (await getDataRow(harness.db, MAIN_SCOPE, home!.id))!.createdByUserId!)

    // 2. Edit draft to disable template and publish v2.
    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, {
      cells: {
        ...home!.cells,
        title: 'Static Page V2',
        templateEnabled: false,
        templateTarget: null,
        templatePriority: null,
      },
      slug: home!.slug,
    })
    const pubRes = await harness.cms(`${ROWS}/${home!.id}/publish`, { method: 'POST', cookie: owner })
    expect(pubRes.status).toBe(200)

    // 3. List versions and restore v1.
    const listed = await readJson<{ versions: Array<{ id: string; versionNumber: number }> }>(
      await harness.cms(`${ROWS}/${home!.id}/versions`, { cookie: owner }),
    )
    const v1 = listed.versions.find((v) => v.versionNumber === 1)!
    const restored = await harness.cms(`${ROWS}/${home!.id}/versions/${v1.id}/restore`, {
      method: 'POST',
      cookie: owner,
    })
    expect(restored.status).toBe(200)

    // 4. Verify template settings are restored to v1.
    const draft = await getDataRow(harness.db, MAIN_SCOPE, home!.id)
    expect(draft!.cells.title).toBe('Template Page V1')
    expect(draft!.cells.templateEnabled).toBe(true)
    expect(draft!.cells.templateTarget).toEqual(templateConfig)
    expect(draft!.cells.templatePriority).toBe(5)
  })
})
