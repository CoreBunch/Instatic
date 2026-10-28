import '@modules/base'
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageToCells } from '@core/data/pageFromRow'
import { createTestDb } from '../helpers/createTestDb'
import { saveDraftSite } from '../../../server/repositories/site'
import { createDataRow } from '../../../server/repositories/data'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { publishDataRow } from '../../../server/publish/publishRow'
import { readArtefact } from '../../../server/publish/staticArtefact'
import { handleHoleRequest } from '../../../server/handlers/cms/hole'
import { resetPublishStateForTests, bumpPublishVersionSerialized } from '../../../server/publish/publishState'

function makeShell(): SiteShell {
  return {
    id: 'project_1',
    name: 'Repro Site',
    files: [],
    visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {} },
    styleRules: {},
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: normalizeSiteRuntimeConfig(undefined),
    createdAt: 1000,
    updatedAt: 2000,
  }
}

function makePage(id: string, slug: string, title: string, text: string) {
  return {
    id, title, slug, rootNodeId: 'root',
    nodes: {
      root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: ['text_1'], classIds: [] },
      text_1: { id: 'text_1', moduleId: 'base.text', props: { text, tag: 'h1' }, breakpointOverrides: {}, children: [], classIds: [] },
    },
  }
}

test('an unrelated post publish keeps baked page fragments usable', async () => {
  resetPublishStateForTests()
  const { db, cleanup } = await createTestDb()
  const dir = await mkdtemp(join(tmpdir(), 'hole-publication-'))
  try {
    await db`insert into users (id,email,email_normalized,display_name,password_hash,role_id)
      values ('owner','owner@example.test','owner@example.test','Owner','x','owner')`
    await saveDraftSite(db, MAIN_SCOPE, makeShell())
    const page = makePage('home', 'index', 'Home', 'Hello {route.query.q}')
    await createDataRow(db, MAIN_SCOPE, { id: 'home', tableId: 'pages', slug: 'index', cells: pageToCells(page) })
    await createDataRow(db, MAIN_SCOPE, { id: 'post', tableId: 'posts', slug: 'test', cells: { title: 'Post', body: 'Hello' } })
    await publishDraftSite(db, 'owner', dir)
    const before = await readArtefact(dir, '/')
    expect(before).toContain('instatic-hole')
    const version = before!.match(/data-instatic-version="([^"]+)"/)![1]
    const url = new URL(`http://localhost/_instatic/hole/text_1?v=${version}&u=${encodeURIComponent('/?q=world')}`)
    const fragment = async () => (await handleHoleRequest(new Request(url), url, { db })).text()
    expect(await fragment()).toContain('Hello world')
    await publishDataRow(db, 'post', 'owner', dir)
    expect(await readArtefact(dir, '/')).toBe(before)
    expect(await fragment()).toContain('Hello world')
    // Scheduler/plugin publishing without an artefact directory uses the same path.
    await publishDataRow(db, 'post', 'owner')
    expect(await fragment()).toContain('Hello world')
    // Deletes/unpublishes invalidate caches through this same serialized bump.
    await bumpPublishVersionSerialized()
    expect(await fragment()).toContain('Hello world')
    // Restarting the process resets caches and the counter, not the frozen site.
    resetPublishStateForTests()
    expect(await fragment()).toContain('Hello world')
  } finally {
    await cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})
