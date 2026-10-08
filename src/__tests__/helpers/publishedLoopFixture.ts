import '@modules/base'
import '@core/loops/sources'
import type { SiteDocument } from '@core/page-tree'
import { makeNode, makePage, makeSite, makeVC, makeVCTree } from '../fixtures'
import { createTestDb } from './createTestDb'

export const LOOP_TEST_LANGUAGES = ['it', 'en', 'fr', 'es', 'de', 'pt', 'nl', 'pl', 'ro'] as const

export function publishedLoopSite(): SiteDocument {
  const component = makeVC({ id: 'listing', name: 'Listing', params: [
    { id: 'heading', name: 'Heading', type: 'string', required: true, defaultValue: 'Default heading' },
    { id: 'more', name: 'More', type: 'string', required: true, defaultValue: '{site.translations.loop.more}' },
    { id: 'cards', name: 'cards', type: 'slot', required: false },
  ], tree: makeVCTree('vc-root', [
    makeNode({ id: 'vc-root', moduleId: 'base.container', children: ['shared-loop'] }),
    makeNode({ id: 'shared-loop', moduleId: 'base.loop', children: ['card'], propBindings: { loadMoreLabel: { paramId: 'more' } }, props: {
      sourceId: 'data.rows', filters: { tableId: 'posts' }, pagination: 'infinite', pageSize: 1,
      orderBy: 'slug', direction: 'asc', loadingLabel: '{site.translations.loop.loading}', retryLabel: '{site.translations.loop.retry}',
    } }),
    makeNode({ id: 'card', moduleId: 'base.container', props: { tag: 'article' }, children: ['heading', 'context', 'slot'] }),
    makeNode({ id: 'heading', moduleId: 'base.text', props: { text: '' }, propBindings: { text: { paramId: 'heading' } } }),
    makeNode({ id: 'context', moduleId: 'base.link', props: {
      text: '{site.translations.loop.card}|{site.language}|{page.language}|{page.title}|{page.permalink}|{site.name}|{route.path}|{currentEntry.title}',
      href: '{file.manual.url}',
    } }),
    makeNode({ id: 'slot', moduleId: 'base.slot-outlet', props: { slotName: 'cards' } }),
  ]) })
  const pages = LOOP_TEST_LANGUAGES.map((language) => makePage({
    id: `page-${language}`, slug: `${language}/listing`, title: `Page ${language}`, language, translationGroup: 'listing', nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['ref'] }),
      ref: makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: 'listing', propOverrides: { heading: `Heading ${language}`, more: '{site.translations.loop.more}' } }, children: ['fill'] }),
      fill: makeNode({ id: 'fill', moduleId: 'base.slot-instance', props: { slotName: 'cards' }, children: ['slot-text'] }),
      'slot-text': makeNode({ id: 'slot-text', moduleId: 'base.text', props: { text: 'Slot {currentEntry.title}/{parentEntry.title}' } }),
    },
  }))
  const layout = makePage({ id: 'layout', slug: 'layout', language: 'it', title: 'Layout', template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 }, nodes: {
    'layout-root': makeNode({ id: 'layout-root', moduleId: 'base.body', children: ['layout-outlet'] }),
    'layout-outlet': makeNode({ id: 'layout-outlet', moduleId: 'base.outlet' }),
  }, rootNodeId: 'layout-root' })
  const files = LOOP_TEST_LANGUAGES.map((language) => ({
    id: language, path: `locales/${language}.json`, type: 'config' as const,
    content: JSON.stringify({ language, messages: { loop: { more: `${language} more`, loading: `${language} loading`, retry: `${language} retry`, card: `${language} card` } } }),
    createdAt: 0, updatedAt: 0,
  }))
  return makeSite({ name: 'Published loop site', pages: [...pages, layout], visualComponents: [component],
    files: [...files, { id: 'manual', path: 'public/manual.pdf', type: 'asset', blob: { mimeType: 'application/pdf', base64: 'JVBERi0xLjcK' }, createdAt: 0, updatedAt: 0 }],
    settings: { shortcuts: {}, language: 'it', localization: { catalogues: LOOP_TEST_LANGUAGES.map((language) => ({ language, fileId: language })) } },
  })
}

/** Real, migrated disposable database; its public route rows point to one published snapshot. */
export async function createPublishedLoopFixture(site = publishedLoopSite()) {
  const testDb = await createTestDb()
  const { db } = testDb
  await db`insert into site_snapshots (id, site_json, content_hash) values ('loop-snapshot', ${site}, 'loop-fixture')`
  for (const page of site.pages) {
    await db`insert into data_rows (id, table_id, cells_json, slug, status) values (${page.id}, 'pages', ${{ title: 'Draft title', language: 'it' }}, ${page.slug}, 'published')`
    const versionId = `${page.id}-version`
    await db`insert into data_row_versions (id, row_id, version_number, cells_json, slug, site_snapshot_id)
      values (${versionId}, ${page.id}, 1, ${{ title: page.title }}, ${page.slug}, 'loop-snapshot')`
    await db`update data_rows set active_version_id = ${versionId} where id = ${page.id}`
  }
  for (const [slug, title] of [['alpha', 'Alpha'], ['beta', 'Beta'], ['gamma', 'Gamma']]) {
    const id = `post-${slug}`
    const versionId = `${id}-version`
    await db`insert into data_rows (id, table_id, cells_json, slug, status) values (${id}, 'posts', ${{ title: 'Draft post' }}, ${slug}, 'published')`
    await db`insert into data_row_versions (id, row_id, version_number, cells_json, slug) values (${versionId}, ${id}, 1, ${{ title, body: 'Published body' }}, ${slug})`
    await db`update data_rows set active_version_id = ${versionId} where id = ${id}`
  }
  return { ...testDb, site }
}
