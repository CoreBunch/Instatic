import '@modules/base'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderPublicResolution } from '../../../server/publish/publicRouter'
import { tickPublishScheduler } from '../../../server/publish/publishScheduler'
import { readArtefact } from '../../../server/publish/staticArtefact'
import { createCapabilityTestHarness, readJson } from '../helpers/capabilityHarness'
import { describe, expect, it } from 'bun:test'
import type { Page, SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { saveDraftSite } from '../../../server/repositories/site'
import {
  getPublishedPageBySlug,
  getLatestPublishedSiteSnapshot,
} from '../../../server/repositories/publish'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { publishDataRow } from '../../../server/publish/publishRow'
import { createDataRow, saveDataRowDraft, getDataRow, scheduleDataRowPublish } from '../../../server/repositories/data'
import { pageToCells } from '../../core/data/pageFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createTestDb } from '../helpers/createTestDb'

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

describe('per-row publish of a pages row', () => {
  it('keeps edited pages and the site snapshot available to visitors', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await db`
        insert into users (id, email, email_normalized, display_name, password_hash, role_id)
        values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'admin')
      `
      await saveDraftSite(db, MAIN_SCOPE, makeShell())
      for (const page of [
        makePage('page_home', 'index', 'Home', 'Home v1'),
        makePage('page_about', 'about', 'About', 'About v1'),
      ]) {
        await createDataRow(db, MAIN_SCOPE, {
          id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug,
        }, 'admin_1')
      }

      await publishDraftSite(db, 'admin_1')
      expect(await getPublishedPageBySlug(db, 'about')).not.toBeNull()
      expect(await getLatestPublishedSiteSnapshot(db)).not.toBeNull()

      // Edit the About page and publish that row on its own.
      const edited = makePage('page_about', 'about', 'About', 'About v2')
      await saveDataRowDraft(db, MAIN_SCOPE, 'page_about', { cells: pageToCells(edited), slug: 'about' }, 'admin_1')
      await publishDataRow(db, 'page_about', 'admin_1')

      // A published page version must carry its frozen site snapshot.
      const { rows: versions } = await db<{ row_id: string; site_snapshot_id: string | null }>`
        select data_rows.id as row_id, data_row_versions.site_snapshot_id
        from data_rows
        join data_row_versions on data_row_versions.id = data_rows.active_version_id
        where data_rows.id = 'page_about'
      `
      expect(versions[0]?.site_snapshot_id).not.toBeNull()

      // The active snapshot must include the published edit.
      expect((await getPublishedPageBySlug(db, 'about'))?.site.pages.find((page) => page.id === 'page_about')?.nodes.text_1.props.text).toBe('About v2')

      // Publishing the oldest page must preserve the site's shared snapshot.
      await publishDataRow(db, 'page_home', 'admin_1')
      expect(await getPublishedPageBySlug(db, 'index')).not.toBeNull()
      expect((await getLatestPublishedSiteSnapshot(db))?.site.pages.find((page) => page.id === 'page_about')?.nodes.text_1.props.text).toBe('About v2')
    } finally {
      await cleanup()
    }
  }, 30_000)
})


it('publishes only the selected draft while rebuilding disk and live output from published resources', async () => {
  const { db, cleanup } = await createTestDb()
  const uploads = await mkdtemp(join(tmpdir(), 'page-publish-'))
  try {
    await db`insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'admin')`
    const shell = makeShell()
    shell.files = [{ id: 'style', path: 'style.css', type: 'style', content: 'body { color: blue; }', createdAt: 1, updatedAt: 1 }]
    await saveDraftSite(db, MAIN_SCOPE, shell)
    for (const page of [makePage('home', 'index', 'Home', 'Home v1'), makePage('about', 'about', 'About', 'About v1')]) {
      await createDataRow(db, MAIN_SCOPE, { id: page.id, tableId: 'pages', slug: page.slug, cells: pageToCells(page) }, 'admin_1')
    }
    const componentBody = { rootNodeId: 'label', nodes: { label: { id: 'label', moduleId: 'base.text', props: { text: 'Published component' }, children: [], classIds: [], breakpointOverrides: {} } } }
    await createDataRow(db, MAIN_SCOPE, { id: 'badge', tableId: 'components', slug: 'badge', cells: { name: 'Badge', body: componentBody, params: [], classIds: [] } })
    await publishDraftSite(db, 'admin_1', uploads)
    await saveDraftSite(db, MAIN_SCOPE, { ...shell, name: 'Private site name', files: [{ ...shell.files[0]!, content: 'body { color: red; }' }] })
    await saveDataRowDraft(db, MAIN_SCOPE, 'badge', { cells: { name: 'Badge', body: { ...componentBody, nodes: { label: { ...componentBody.nodes.label, props: { text: 'Private component' } } } }, params: [], classIds: [] }, slug: 'badge' })
    await saveDataRowDraft(db, MAIN_SCOPE, 'home', { cells: pageToCells(makePage('home', 'private-home', 'Private home', 'Private home content')), slug: 'private-home' })
    const homeDraft = await getDataRow(db, MAIN_SCOPE, 'home')
    const hidden = makePage('hidden', 'hidden', 'Hidden', 'Never published')
    await createDataRow(db, MAIN_SCOPE, { id: hidden.id, tableId: 'pages', slug: hidden.slug, cells: pageToCells(hidden) })
    const about: Page = makePage('about', 'renamed', 'About', 'About v2')
    about.nodes.root.children.push('badgeRef')
    about.nodes.badgeRef = { id: 'badgeRef', moduleId: 'base.visual-component-ref', props: { componentId: 'badge', propOverrides: {} }, children: [], classIds: [], breakpointOverrides: {} }
    await saveDataRowDraft(db, MAIN_SCOPE, about.id, { cells: pageToCells(about), slug: about.slug })
    await publishDataRow(db, about.id, 'admin_1', uploads)
    expect(await getDataRow(db, MAIN_SCOPE, 'home')).toEqual(homeDraft)
    expect((await getDataRow(db, MAIN_SCOPE, 'hidden'))?.status).toBe('draft')
    const snapshot = await getLatestPublishedSiteSnapshot(db)
    expect(snapshot?.site.name).toBe(shell.name)
    expect(snapshot?.site.files).toEqual(shell.files)
    expect(snapshot?.site.visualComponents[0]?.tree.nodes.label.props.text).toBe('Published component')
    expect(snapshot?.site.pages.map((page) => page.slug).sort()).toEqual(['index', 'renamed'])
    for (const dir of [uploads, undefined]) {
      expect(await (await renderPublicResolution(db, new URL('http://localhost/renamed'), dir))?.text()).toContain('About v2')
      expect(await (await renderPublicResolution(db, new URL('http://localhost/'), dir))?.text()).toContain('Home v1')
      expect(await renderPublicResolution(db, new URL('http://localhost/private-home'), dir)).toBeNull()
      expect(await renderPublicResolution(db, new URL('http://localhost/hidden'), dir)).toBeNull()
      expect(await renderPublicResolution(db, new URL('http://localhost/about'), dir)).toBeNull()
    }
    expect(await readArtefact(uploads, '/about')).toBeNull()
    const html = await readArtefact(uploads, '/renamed')
    expect(html).toContain('Published component')
    expect(html).not.toContain('Private component')
    // A new draft may claim a slug another page still owns publicly.
    const conflicting = makePage('conflict', 'index', 'Conflict', 'Must stay private')
    await createDataRow(db, MAIN_SCOPE, { id: conflicting.id, tableId: 'pages', slug: conflicting.slug, cells: pageToCells(conflicting) })
    await expect(publishDataRow(db, conflicting.id, 'admin_1', uploads)).rejects.toThrow('belongs to another page')
    expect(await readArtefact(uploads, '/')).toContain('Home v1')
    // A reference to an unpublished component must fail before replacing the active snapshot.
    about.nodes.badgeRef.props.componentId = 'draft-only-component'
    await saveDataRowDraft(db, MAIN_SCOPE, about.id, { cells: pageToCells(about), slug: about.slug })
    await expect(publishDataRow(db, about.id, 'admin_1', uploads)).rejects.toThrow('unpublished component')
    expect(await readArtefact(uploads, '/renamed')).toContain('Published component')
    // Publishing a never-published page must extend the same frozen site.
    await publishDataRow(db, hidden.id, 'admin_1', uploads)
    expect(await readArtefact(uploads, '/hidden')).toContain('Never published')
    expect(await readArtefact(uploads, '/renamed')).toContain('About v2')
    expect(await readArtefact(uploads, '/')).toContain('Home v1')
  } finally {
    await cleanup()
    await rm(uploads, { recursive: true, force: true })
  }
})

it('publishes the only page on schedule without needing another published carrier page', async () => {
  const { db, cleanup } = await createTestDb()
  try {
    await db`insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'admin')`
    await saveDraftSite(db, MAIN_SCOPE, makeShell())
    const home = makePage('home', 'index', 'Home', 'Before schedule')
    await createDataRow(db, MAIN_SCOPE, { id: home.id, tableId: 'pages', slug: home.slug, cells: pageToCells(home) })
    await publishDraftSite(db, 'admin_1')
    await saveDataRowDraft(db, MAIN_SCOPE, home.id, { slug: home.slug, cells: pageToCells(makePage('home', 'index', 'Home', 'Scheduled edit')) })
    await scheduleDataRowPublish(db, MAIN_SCOPE, home.id, new Date(Date.now() - 1000).toISOString())
    await tickPublishScheduler(db)
    const row = await getDataRow(db, MAIN_SCOPE, home.id)
    expect(row?.status).toBe('published')
    expect(row?.publishedByUserId).toBeNull()
    expect(await (await renderPublicResolution(db, new URL('http://localhost/')))?.text()).toContain('Scheduled edit')
  } finally {
    await cleanup()
  }
})

it('returns a clear HTTP error before any page version is written if the site has never been published', async () => {
  const harness = await createCapabilityTestHarness()
  try {
    const cookie = await harness.setupOwner()
    const { rows } = await harness.db<{ id: string }>`select id from data_rows where table_id = 'pages' limit 1`
    const rowId = rows[0]!.id
    const before = await getDataRow(harness.db, MAIN_SCOPE, rowId)
    const response = await harness.cms(`/admin/api/cms/data/rows/${rowId}/publish`, { method: 'POST', cookie })
    expect(response.status).toBe(409)
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Publish the site first before publishing an individual page.' })
    expect(await getDataRow(harness.db, MAIN_SCOPE, rowId)).toEqual(before)
    const { rows: versions } = await harness.db`select id from data_row_versions`
    expect(versions).toHaveLength(0)
  } finally {
    await harness.cleanup()
  }
})
