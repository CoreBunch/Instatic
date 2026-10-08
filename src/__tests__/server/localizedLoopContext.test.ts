import { describe, expect, it } from 'bun:test'
import { createPublishedLoopFixture, LOOP_TEST_LANGUAGES, publishedLoopSite } from '../helpers/publishedLoopFixture'
import { getPublishedPageBySlug } from '../../../server/repositories/publish'
import { getPublishedDataRowByRoute } from '../../../server/repositories/data/publish'
import { getDataTable } from '../../../server/repositories/data'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { handleLoopRequest } from '../../../server/handlers/cms/loop'
import { renderPublishedSnapshot, renderPublishedDataRowTemplate } from '../../../server/publish/publicRenderer'
import { getPublishVersion } from '../../../server/publish/publishState'
import { readEnvelope } from '@core/http'
import { LoopPageResponseSchema } from '@core/loops-schema'
import { makeNode } from '../fixtures'

async function fixture() {
  const site = publishedLoopSite()
  site.files = site.files.map(file => file.type !== 'config' ? file : {
    ...file, content: JSON.stringify({ language: file.id, messages: {
      loop: { more: `${file.id} more`, loading: `${file.id} loading`, retry: `${file.id} retry`, card: `${file.id} card` },
      articles: { alpha: `${file.id} Alpha`, beta: `${file.id} Beta`, gamma: `${file.id} Gamma` },
    } }),
  })
  site.visualComponents[0].tree.nodes.context.props.text = '{site.language}|{page.language}|{currentEntry.heading}|{currentEntry.ordinary}'
  for (const page of site.pages.filter(page => !page.template?.enabled)) {
    page.nodes['slot-text'].props.text = 'Slot {currentEntry.heading}/{parentEntry.heading}'
    page.nodes.fill.children.push('cards-loop')
    page.nodes['cards-loop'] = makeNode({ id: 'cards-loop', moduleId: 'base.loop', props: { sourceId: 'entry.field', filters: { fieldId: 'cards' } }, children: ['caption'] })
    page.nodes.caption = makeNode({ id: 'caption', moduleId: 'base.text', props: { text: '{currentEntry.caption}' } })
  }
  const entry = structuredClone(site.pages.find(page => page.language === 'de' && !page.template?.enabled)!)
  entry.id = 'localized-entry'
  entry.slug = 'entry-template'
  entry.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 1 }
  entry.nodes.root.children.push('entry-body')
  entry.nodes['entry-body'] = makeNode({ id: 'entry-body', moduleId: 'base.outlet' })
  delete entry.translationGroup
  site.pages.push(entry)
  const test = await createPublishedLoopFixture(site)
  const table = (await getDataTable(test.db, MAIN_SCOPE, 'posts'))!
  const fields = [...table.fields, { id: 'heading', label: 'Heading', type: 'localizedText' as const },
    { id: 'ordinary', label: 'Ordinary', type: 'text' as const },
    { id: 'cards', label: 'Cards', type: 'repeater' as const, fields: [{ id: 'caption', label: 'Caption', type: 'localizedText' as const }] }]
  await test.db`update data_tables set fields_json = ${fields} where id = 'posts'`
  for (const slug of ['alpha', 'beta', 'gamma']) {
    const cells = { title: slug, body: 'Published body', heading: { key: `articles.${slug}` }, ordinary: '{site.translations.articles.alpha}', cards: [{ id: `card-${slug}`, cells: { caption: { key: `articles.${slug}` } } }] }
    await test.db`update data_row_versions set cells_json = ${cells} where id = ${`post-${slug}-version`}`
    await test.db`update data_rows set cells_json = ${{ heading: { key: 'articles.gamma' } }} where id = ${`post-${slug}`}`
  }
  return test
}

function continuation(db: Awaited<ReturnType<typeof fixture>>['db'], path: string) {
  const url = new URL('http://localhost/_instatic/loop/shared-loop')
  url.searchParams.set('pagePath', path)
  url.searchParams.set('page', '2')
  url.searchParams.set('v', String(getPublishVersion()))
  return handleLoopRequest(new Request(url), url, { db })
}

describe('localized collection native public contexts', () => {
  it('keeps scalar and repeater projection in parity across nine published routes, components, params, slots and continuation', async () => {
    const test = await fixture()
    try {
      for (const language of LOOP_TEST_LANGUAGES) {
        const path = `/${language}/listing?category=native`
        const snapshot = (await getPublishedPageBySlug(test.db, `${language}/listing`))!
        const initial = await renderPublishedSnapshot(snapshot, { db: test.db, url: new URL(path, 'http://localhost') })
        expect(initial.html).toContain(`${language}|${language}|${language} Alpha|`)
        expect(initial.html).toContain('Heading ' + language)
        expect(initial.html).toContain(`Slot ${language} Alpha/`)
        const next = await readEnvelope(await continuation(test.db, path), LoopPageResponseSchema, 'Loop failed')
        expect(next.html).toContain(`${language}|${language}|${language} Beta|`)
        expect(next.html).toContain(`Slot ${language} Beta/`)
        expect(next.html).toContain('{site.translations.articles.alpha}')
        expect(next.html).not.toContain(`${language} Gamma`)
        expect(next.html).not.toContain('"key"')
      }
      const { rows: [raw] } = await test.db<{ cells_json: unknown }>`select cells_json from data_row_versions where id = 'post-beta-version'`
      expect(raw.cells_json).toMatchObject({ heading: { key: 'articles.beta' }, cards: [{ id: 'card-beta', cells: { caption: { key: 'articles.beta' } } }] })
    } finally { await test.cleanup() }
  })

  it('projects the published entry root and preserves parentEntry in nested contextual loops and continuation', async () => {
    const test = await fixture()
    try {
      const snapshot = (await getPublishedPageBySlug(test.db, 'entry-template'))!
      const row = (await getPublishedDataRowByRoute(test.db, '/posts', 'alpha'))!
      const initial = await renderPublishedDataRowTemplate(snapshot, row, { db: test.db, url: new URL('http://localhost/posts/alpha') })
      expect(initial?.html).toContain('Slot de Alpha/de Alpha')
      const next = await readEnvelope(await continuation(test.db, '/posts/alpha'), LoopPageResponseSchema, 'Loop failed')
      expect(next.html).toContain('Slot de Beta/de Alpha')
      expect(next.html).toContain('de Beta')
      expect(row.cells.heading).toEqual({ key: 'articles.alpha' })
    } finally { await test.cleanup() }
  })
})
