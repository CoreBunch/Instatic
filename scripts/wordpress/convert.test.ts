import { afterEach, beforeEach, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { parseSiteBundleArchive } from '@core/persistence/cmsTransfer'
import { buildImportPlan, ingestInput } from '@core/siteImport'
import { useEditorStore } from '@site/store/store'
import { DEFAULT_BREAKPOINTS, parseSiteDocument } from '@core/page-tree'
import { convert } from './convert'
import type { Source } from './source'

function sample(): Source {
  const date = '2026-01-02T00:00:00Z'
  const site = 'https://studio.example/'
  return {
    version: 1, site, name: 'Studio', date, blog: 1, warnings: [], inventory: {},
    homeHtml: '<html><head><title>Studio</title></head><body><h1>Studio</h1></body></html>',
    types: [
      { name: 'page', label: 'Pages', singular: 'Page', fields: [], archive: '', archiveHtml: '' },
      { name: 'project', label: 'Projects', singular: 'Project', fields: [
        { key: 'field_budget', name: 'budget', label: 'Budget', type: 'number' },
      ], archive: '', archiveHtml: '' },
    ],
    posts: [{ id: 1, title: 'Atlas', type: 'project', status: 'publish', public: true, passwordProtected: false,
      slug: 'atlas', date, modified: date, raw: 'Body', html: '<html><body><h1>Atlas</h1><div class="entry-content">Body</div></body></html>',
      url: site + 'work/atlas/', featured: 0, terms: {}, fields: { field_budget: '0' }, shortcodes: ['unknown'] }],
    media: [], taxonomies: [],
  }
}
const pack = (source: Source) => zipSync({ 'instatic-wordpress-source.json': strToU8(JSON.stringify(source)) })

let editorState: ReturnType<typeof useEditorStore.getState>
beforeEach(() => { editorState = useEditorStore.getState() })
afterEach(() => { useEditorStore.setState(editorState, true) })

test('Site Import directs private WordPress source packages to the converter', async () => {
  const fileMap = await ingestInput({ zipBytes: pack(sample()) })
  const shell = parseSiteDocument({ id: 'site', name: 'Site', createdAt: 0, updatedAt: 0, breakpoints: DEFAULT_BREAKPOINTS })
  const currentSite = { ...shell, pages: [], layouts: [], visualComponents: [] }
  expect(() => buildImportPlan({ fileMap, currentSite })).toThrow('wordpress:convert')
})

test('WordPress conversion produces a native draft collection with an entry template and reports recovery-only data', async () => {
  const source = sample()
  const atlas = source.posts[0]
  source.posts.push({ ...atlas, id: 2, public: false, status: 'draft', slug: 'draft', url: '', raw: 'Draft copy' })
  source.posts.push({ ...atlas, id: 3, public: false, passwordProtected: true, slug: 'protected', raw: 'Private copy' })
  const result = await convert(pack(source), {})
  const bundle = parseSiteBundleArchive(result.archive)!
  const projects = bundle.tables.find(t => t.slug === 'project')!
  expect(projects.routeBase).toBe('/work')
  const rows = bundle.rows.filter(r => r.tableId === projects.id)
  expect(rows).toHaveLength(2)
  expect(rows.find(r => r.slug === 'atlas')?.cells.acf_budget).toBe(0)
  expect(rows.find(r => r.slug === 'draft')?.cells.body).toBe('Draft copy')
  expect(rows.every(r => r.status === 'draft')).toBe(true)
  expect(JSON.stringify(bundle)).not.toContain('Private copy')
  expect(bundle.rows.some(r => r.cells.templateEnabled && JSON.stringify(r.cells.templateTarget).includes('project'))).toBe(true)
  expect(result.report.warnings.join(' ')).toContain('[unknown]')
})

test('WordPress conversion stops when a public entry cannot supply its body', async () => {
  const source = sample()
  source.posts[0].html = '<h1>Atlas</h1>'
  await expect(convert(pack(source), {})).rejects.toThrow('body selectors')
})
