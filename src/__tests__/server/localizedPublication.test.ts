import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makePage, makeSite } from '../publisher/helpers'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { pageToCells } from '@core/data/pageFromRow'
import { makePageRef } from '@core/page-tree'
import { saveDraftSite, getDraftSite } from '../../../server/repositories/site'
import { createDataRow, getDataRow, updateDataRowStatus } from '../../../server/repositories/data'
import { createLocale, saveContentLocalizationDraft, saveTableLocalization, updateLocale } from '../../../server/repositories/localization'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { publishDataRow } from '../../../server/publish/publishRow'
import { getPublishVersion, bumpPublishVersionSerialized, arePublishedArtefactsCurrent } from '../../../server/publish/publishState'
import { loadPublishedRouteInventory } from '../../../server/publish/publishedRoutes'
import { renderNotFoundResponse, renderPublicResolution } from '../../../server/publish/publicRouter'
import { handleHoleRequest } from '../../../server/handlers/cms/hole'
import { handleLoopRequest } from '../../../server/handlers/cms/loop'
import { readArtefact } from '../../../server/publish/staticArtefact'
import { scheduleLocalizedDataRowPublish } from '../../../server/publish/schedulePublication'
import { tickPublishScheduler } from '../../../server/publish/publishScheduler'
import { getPublishedDataRowById } from '../../../server/repositories/data'
import { handleServerRequest } from '../../../server/router'
import { resetForTests } from '../../../server/publish/renderCache'
import { getLatestPublishedSiteSnapshot } from '../../../server/repositories/publish'

let testDb: TestDb
let uploadsDir: string
let fr: string
const publicUrl = (path: string) => new URL(path, 'https://site.test')

beforeEach(async () => {
  resetForTests()
  testDb = await createTestDb()
  uploadsDir = await mkdtemp(join(tmpdir(), 'localized-publish-'))
  const site = makeSite({ layouts: [] })
  site.settings.publicOrigin = 'https://site.test'
  await saveDraftSite(testDb.db, site)
  fr = (await createLocale(testDb.db, { code: 'fr', name: 'Français', pathPrefix: 'fr', enabled: true, direction: 'ltr' })).id
})

afterEach(async () => {
  await testDb.cleanup()
  await rm(uploadsDir, { recursive: true, force: true })
  resetForTests()
})

async function page(id: string, slug: string, text: string, extraNodes: Parameters<typeof makePage>[0] = {}) {
  const value = { ...makePage({ root: { moduleId: 'base.container', children: ['copy', ...Object.keys(extraNodes).filter((id) => !Object.values(extraNodes).some((node) => node.children?.includes(id)))] },
    copy: { moduleId: 'base.text', props: { text, tag: 'p', htmlAttributes: {} } }, ...extraNodes }), id, slug, title: text }
  return createDataRow(testDb.db, { id, tableId: 'pages', slug, cells: pageToCells(value) })
}

async function translate(rowId: string, slug: string, text: string) {
  await saveContentLocalizationDraft(testDb.db, rowId, fr, {
    slug, cells: { title: text, seoTitle: `${text} SEO`, seoDescription: `${text} description`, body: { nodes: { copy: { props: { text } } } } },
  })
}

async function html(path: string, disk = true): Promise<string> {
  const response = await renderPublicResolution(testDb.db, publicUrl(path), disk ? uploadsDir : undefined)
  expect(response?.status).toBe(200)
  return response!.text()
}

async function hole(path: string, nodeId = 'copy'): Promise<Response> {
  const url = publicUrl(`/_instatic/hole/${nodeId}?v=${getPublishVersion()}&u=${encodeURIComponent(path)}`)
  return handleHoleRequest(new Request(url), url, { db: testDb.db })
}

describe('locale publication end to end', () => {
  it('recreates each live release CSS after independent language publications without disk artefacts', async () => {
    await page('about', 'about', 'About')
    await translate('about', 'a-propos', 'À propos')
    const shell = await getDraftSite(testDb.db)
    expect(shell).not.toBeNull()
    const stylesheet = { id: 'theme', path: 'theme.css', type: 'style' as const, content: 'body{color:maroon}', createdAt: 1, updatedAt: 1 }
    await saveDraftSite(testDb.db, { ...shell!, files: [stylesheet] })
    await publishDraftSite(testDb.db, null, undefined, { variants: [{ rowId: 'about', localeId: 'default' }] })
    await saveDraftSite(testDb.db, { ...shell!, files: [{ ...stylesheet, content: 'body{color:navy}' }] })
    await publishDraftSite(testDb.db, null, undefined, { variants: [{ rowId: 'about', localeId: fr }] })
    for (const [path, color] of [['/about', 'maroon'], ['/fr/a-propos', 'navy']]) {
      const body = await html(path, false)
      const cssPath = body.match(/href="(\/_instatic\/css\/userStyles-[^"]+\.css)"/)?.[1]
      expect(cssPath).toBeString()
      const response = await handleServerRequest(new Request(publicUrl(cssPath!)), { db: testDb.db })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(color)
    }
  })

  it('publishes only selected variants with frozen independent URLs, metadata and fragments', async () => {
    await page('about', 'about', 'About source')
    await page('private', 'private', 'Private source')
    await translate('about', 'a-propos', 'À propos')
    await publishDraftSite(testDb.db, null, uploadsDir, { variants: [{ rowId: 'about', localeId: fr }] })
    expect((await loadPublishedRouteInventory(testDb.db)).routes.map((route) => route.path)).toEqual(['/fr/a-propos'])
    expect(await renderPublicResolution(testDb.db, publicUrl('/about'), uploadsDir)).toBeNull()
    const french = await html('/fr/a-propos')
    expect(french).toContain('<html lang="fr" dir="ltr">')
    expect(french).toContain('<title>À propos SEO</title>')
    expect(french).toContain('href="https://site.test/fr/a-propos"')
    expect(french).not.toContain('x-default')
    expect(await (await hole('/fr/a-propos')).text()).toContain('À propos')
    expect((await hole('/about')).status).toBe(404)
    expect((await hole('/private')).status).toBe(404)
    await publishDraftSite(testDb.db, null, uploadsDir)
    expect((await loadPublishedRouteInventory(testDb.db)).routes).toHaveLength(1)
  })

  it('allocates distinct versions across locales and keeps secondary online after source retraction', async () => {
    await page('about', 'about', 'Source title')
    await translate('about', 'a-propos', 'Titre français')
    await publishDraftSite(testDb.db, null, uploadsDir, { variants: [{ rowId: 'about', localeId: 'default' }, { rowId: 'about', localeId: fr }] })
    const english = await html('/about')
    expect(english).toContain('hreflang="fr"')
    expect(english).toContain('hreflang="x-default"')
    await updateDataRowStatus(testDb.db, 'about', 'unpublished', null, 'default')
    expect(arePublishedArtefactsCurrent()).toBe(false)
    expect(await readArtefact(uploadsDir, '/about')).not.toBeNull()
    expect(await renderPublicResolution(testDb.db, publicUrl('/about'), uploadsDir)).toBeNull()
    expect((await hole('/about')).status).toBe(404)
    const french = await html('/fr/a-propos')
    expect(french).toContain('Titre français')
    expect(french).not.toContain('hreflang="x-default"')
    const sitemap = await renderPublicResolution(testDb.db, publicUrl('/sitemap.xml'))
    expect(await sitemap!.text()).not.toContain('https://site.test/about')
  })

  it('refreshes links and site-page lists when a previously absent translation comes online or goes offline', async () => {
    await page('nav', 'index', 'Navigation', {
      link: { moduleId: 'base.button', props: { text: 'Go', href: makePageRef('destination') } },
      loop: { moduleId: 'base.loop', props: { sourceId: 'site.pages', filters: {}, pagination: 'infinite', pageSize: 20 }, children: ['item'] },
      item: { moduleId: 'base.text', props: { text: '{currentEntry.title}', tag: 'p', htmlAttributes: {} } },
    })
    await translate('nav', 'index', 'Navigation française')
    await publishDraftSite(testDb.db, null, uploadsDir, { variants: [{ rowId: 'nav', localeId: fr }] })
    await page('destination', 'destination', 'Hidden source title')
    await translate('destination', 'destination-fr', 'Nouvelle destination')
    await publishDataRow(testDb.db, 'destination', null, uploadsDir, { localeId: fr })
    const published = await html('/fr')
    expect(published).toContain('/fr/destination-fr')
    expect(published).toContain('Nouvelle destination')
    const loopUrl = publicUrl(`/_instatic/loop/loop?page=1&pagePath=${encodeURIComponent('/fr')}`)
    const loopResult = await handleLoopRequest(new Request(loopUrl), loopUrl, { db: testDb.db })
    expect(loopResult.status).toBe(200)
    expect(await loopResult.text()).toContain('Nouvelle destination')
    await updateDataRowStatus(testDb.db, 'destination', 'unpublished', null, fr)
    const retracted = await html('/fr')
    expect(retracted).not.toContain('/fr/destination-fr')
    expect(retracted).not.toContain('Nouvelle destination')
    expect(retracted).not.toContain('Hidden source title')
    await updateDataRowStatus(testDb.db, 'nav', 'unpublished', null, fr)
    expect((await handleLoopRequest(new Request(loopUrl), loopUrl, { db: testDb.db })).status).toBe(404)
  })

  it('does not rename published URLs or hreflang after draft language configuration changes', async () => {
    await page('about', 'about', 'Source')
    await translate('about', 'a-propos', 'Version française')
    await publishDataRow(testDb.db, 'about', null, uploadsDir, { localeId: fr })
    await translate('about', 'nouveau', 'New draft')
    await updateLocale(testDb.db, fr, { code: 'fr-CA', pathPrefix: 'canada', direction: 'rtl' })
    await bumpPublishVersionSerialized()
    const frozen = await html('/fr/a-propos')
    expect(frozen).toContain('<html lang="fr" dir="ltr">')
    expect(frozen).toContain('hreflang="fr"')
    expect(frozen).not.toContain('New draft')
    expect(await renderPublicResolution(testDb.db, publicUrl('/canada/nouveau'))).toBeNull()
    await publishDataRow(testDb.db, 'about', null, uploadsDir, { localeId: fr })
    const redirect = await renderPublicResolution(testDb.db, publicUrl('/fr/a-propos?campaign=1'), uploadsDir)
    expect(redirect?.status).toBe(301)
    expect(redirect?.headers.get('location')).toBe('/canada/nouveau?campaign=1')
    expect(await html('/canada/nouveau')).toContain('<html lang="fr-CA" dir="rtl">')
  })

  it('keeps the stored language of releases created before localization when the source language is renamed', async () => {
    await page('about', 'about', 'Published before localization')
    await updateLocale(testDb.db, 'default', { code: 'ar', direction: 'rtl' })
    await publishDataRow(testDb.db, 'about', null)
    const snapshot = (await getLatestPublishedSiteSnapshot(testDb.db, 'default'))!
    const { locales: _locales, localeId: _localeId, ...withoutLocales } = snapshot.site
    const storedSite = { ...withoutLocales, settings: { ...withoutLocales.settings, language: 'ar' } }
    // Model the persisted pre-localization JSON shape without rewriting it on reads.
    await testDb.db`update site_snapshots set site_json = ${storedSite} where id = ${snapshot.siteSnapshotId}`
    await updateLocale(testDb.db, 'default', { code: 'de', direction: 'ltr' })
    await bumpPublishVersionSerialized()
    const route = (await loadPublishedRouteInventory(testDb.db)).routes[0]
    expect(route.languageCode).toBe('ar')
    expect(route.direction).toBe('rtl')
    const published = await html('/about', false)
    expect(published).toContain('<html lang="ar" dir="rtl">')
    expect(published).toContain('hreflang="ar"')
    expect(published).not.toContain('hreflang="de"')
    expect((await testDb.db`select site_json from site_snapshots where id = ${snapshot.siteSnapshotId}`).rows[0].site_json).toEqual(storedSite)
    await publishDataRow(testDb.db, 'about', null)
    expect((await loadPublishedRouteInventory(testDb.db)).routes[0].languageCode).toBe('de')
  })

  it('rejects a conflicting frozen language code before activating any selected release', async () => {
    await page('about', 'about', 'Source')
    await page('other', 'other', 'Still private')
    await translate('about', 'a-propos', 'Version française')
    await publishDataRow(testDb.db, 'about', null, undefined, { localeId: fr })
    const original = (await loadPublishedRouteInventory(testDb.db)).routes[0]
    const version = getPublishVersion()
    const versions = await testDb.db`select id from data_row_versions`
    const snapshots = await testDb.db`select id from site_snapshots`
    await updateLocale(testDb.db, fr, { code: 'fr-CA' })
    const replacement = await createLocale(testDb.db, { code: 'fr', name: 'Français de France', pathPrefix: 'france', enabled: true, direction: 'ltr' })
    await expect(publishDraftSite(testDb.db, null, undefined, { variants: [
      { rowId: 'other', localeId: 'default' }, { rowId: 'about', localeId: replacement.id },
    ] })).rejects.toThrow('already published for this content')
    expect((await loadPublishedRouteInventory(testDb.db)).routes).toEqual([original])
    expect((await testDb.db`select id from data_row_versions`).rows).toEqual(versions.rows)
    expect((await testDb.db`select id from site_snapshots`).rows).toEqual(snapshots.rows)
    expect(getPublishVersion()).toBe(version)
    await publishDraftSite(testDb.db, null, undefined, { variants: [
      { rowId: 'about', localeId: fr }, { rowId: 'about', localeId: replacement.id },
    ] })
    expect((await loadPublishedRouteInventory(testDb.db)).routes.map((route) => route.languageCode).toSorted()).toEqual(['fr', 'fr-CA'])
  })

  it('publishes CMS variants through a frozen same-language template and translated collection base', async () => {
    const template = { ...makePage({ root: { moduleId: 'base.text', props: { text: '{currentEntry.title}', tag: 'p', htmlAttributes: {} } } }),
      id: 'entry-template', slug: 'entry-template', template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 } }
    await createDataRow(testDb.db, { id: template.id, tableId: 'pages', slug: template.slug, cells: pageToCells(template) })
    await publishDraftSite(testDb.db, null, uploadsDir, { variants: [{ rowId: template.id, localeId: fr }] })
    await createDataRow(testDb.db, { id: 'post', tableId: 'posts', slug: 'post', cells: { title: 'Source article', body: 'Source body' } })
    await saveContentLocalizationDraft(testDb.db, 'post', fr, { slug: 'article', cells: { title: 'Article français', body: 'Texte français' } })
    await saveTableLocalization(testDb.db, 'posts', fr, '/actualites')
    await publishDataRow(testDb.db, 'post', null, uploadsDir, { localeId: fr })
    expect(await html('/fr/actualites/article')).toContain('Article français')
    expect(await renderPublicResolution(testDb.db, publicUrl('/fr/entry-template'))).toBeNull()
    expect(await renderPublicResolution(testDb.db, publicUrl('/posts/post'))).toBeNull()
    await updateDataRowStatus(testDb.db, 'post', 'unpublished', null, fr)
    expect(await renderPublicResolution(testDb.db, publicUrl('/fr/actualites/article'), uploadsDir)).toBeNull()
  })

  it('publishes a template and then a CMS route while the source homepage stays offline', async () => {
    await page('home', 'index', 'Private homepage')
    await createDataRow(testDb.db, { id: 'post', tableId: 'posts', slug: 'post', cells: { title: 'Public article', body: 'Article body' } })
    await publishDataRow(testDb.db, 'post', null)
    expect((await loadPublishedRouteInventory(testDb.db)).routes).toEqual([])
    const template = { ...makePage({ root: { moduleId: 'base.text', props: { text: '{currentEntry.title}', tag: 'p', htmlAttributes: {} } } }),
      id: 'post-template', slug: 'post-template', template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 } }
    await createDataRow(testDb.db, { id: template.id, tableId: 'pages', slug: template.slug, cells: pageToCells(template) })
    await publishDraftSite(testDb.db, null, uploadsDir, { variants: [{ rowId: template.id, localeId: 'default' }] })
    await publishDataRow(testDb.db, 'post', null, uploadsDir)
    expect(await html('/posts/post')).toContain('Public article')
    expect(await renderPublicResolution(testDb.db, publicUrl('/'), uploadsDir)).toBeNull()
    expect(await renderPublicResolution(testDb.db, publicUrl('/post-template'), uploadsDir)).toBeNull()
    expect((await getDataRow(testDb.db, 'home'))?.localization?.availability).toBe('offline')
  })

  it('freezes template dependencies without activating unselected template variants', async () => {
    await page('home', 'index', 'Homepage')
    for (const id of ['active-template', 'offline-template']) {
      const template = { ...makePage({ root: { moduleId: 'base.text', props: { text: id, tag: 'p', htmlAttributes: {} } } }),
        id, slug: id, template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 } }
      await createDataRow(testDb.db, { id, tableId: 'pages', slug: id, cells: pageToCells(template) })
    }
    await publishDraftSite(testDb.db, null, undefined, { variants: [{ rowId: 'active-template', localeId: 'default' }] })
    const active = (await getDataRow(testDb.db, 'active-template'))!.localization!
    const offline = (await getDataRow(testDb.db, 'offline-template'))!.localization!
    expect(offline.availability).toBe('offline')
    expect(offline.activeVersionId).toBeNull()
    await publishDraftSite(testDb.db, null, undefined, { variants: [{ rowId: 'home', localeId: 'default' }] })
    expect((await getDataRow(testDb.db, 'active-template'))!.localization).toEqual(active)
    expect((await getDataRow(testDb.db, 'offline-template'))!.localization).toEqual(offline)
    const snapshot = (await getLatestPublishedSiteSnapshot(testDb.db, 'default'))!
    expect(snapshot.site.pages.filter((value) => value.template?.enabled).map((value) => value.id).toSorted())
      .toEqual(['active-template', 'offline-template'])
    expect((await loadPublishedRouteInventory(testDb.db)).dependencies.map((value) => value.contentId)).toEqual(['active-template'])
  })

  it('freezes scheduled page content, routes and shared design dependencies while preserving later drafts', async () => {
    await page('scheduled', 'scheduled', 'Before schedule')
    await translate('scheduled', 'planifie', 'Texte planifié')
    await scheduleLocalizedDataRowPublish(testDb.db, 'scheduled', '2000-01-01T00:00:00.000Z', null, fr)
    await translate('scheduled', 'new-draft-path', 'Unpublished later edit')
    const shell = (await getDraftSite(testDb.db))!
    await saveDraftSite(testDb.db, { ...shell, name: 'Later shared site change' })
    await tickPublishScheduler(testDb.db, uploadsDir)
    const result = await html('/fr/planifie')
    expect(result).toContain('Texte planifié')
    expect(result).not.toContain('Unpublished later edit')
    expect(result).not.toContain('Later shared site change')
    expect((await getDataRow(testDb.db, 'scheduled', fr))?.cells.title).toBe('Unpublished later edit')
    expect((await getPublishedDataRowById(testDb.db, 'scheduled', fr))?.slug).toBe('planifie')
  })
})


describe('published locale navigation', () => {
  it('switches the same logical page only to online alternatives and removes links after retraction', async () => {
    await page('about', 'about', 'About', { switcher: { moduleId: 'base.language-switcher', props: { label: 'Select language', hideIfSingle: true, showCurrent: true, display: 'name' } } })
    await translate('about', 'a-propos', 'À propos')
    await createLocale(testDb.db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', enabled: true, direction: 'ltr' })
    await publishDraftSite(testDb.db, null, uploadsDir, { variants: [{ rowId: 'about', localeId: 'default' }, { rowId: 'about', localeId: fr }] })
    const source = await html('/about')
    const switcher = source.match(/<nav[^>]*data-instatic-language-switcher[^>]*>.*?<\/nav>/)?.[0]
    expect(switcher).toContain('href="/fr/a-propos"')
    expect(switcher).toContain('Français')
    expect(switcher).toContain('aria-current="page"')
    expect(switcher).not.toContain('Deutsch')
    expect(await (await hole('/about', 'switcher')).text()).toContain('/fr/a-propos')
    await updateDataRowStatus(testDb.db, 'about', 'unpublished', null, fr)
    expect(await html('/about')).not.toContain('data-instatic-language-switcher')
    expect(await (await hole('/about', 'switcher')).text()).toBe('')
  })

  it('renders a localized not-found template and never falls back through a disabled prefix', async () => {
    const value = { ...makePage({ root: { moduleId: 'base.text', props: { text: 'Not found source', tag: 'p', htmlAttributes: {} } } }),
      id: 'not-found', slug: 'not-found', template: { enabled: true, target: { kind: 'notFound' as const }, priority: 0 } }
    await createDataRow(testDb.db, { id: value.id, tableId: 'pages', slug: value.slug, cells: pageToCells(value) })
    await saveContentLocalizationDraft(testDb.db, value.id, fr, { slug: value.slug, cells: { body: { nodes: { root: { props: { text: 'Page introuvable' } } } } } })
    await publishDraftSite(testDb.db, null, uploadsDir, { variants: [{ rowId: value.id, localeId: 'default' }, { rowId: value.id, localeId: fr }] })
    const response = await renderNotFoundResponse(testDb.db, publicUrl('/fr/missing'), uploadsDir)
    expect(response?.status).toBe(404)
    expect(await response!.text()).toContain('Page introuvable')
    expect(await renderPublicResolution(testDb.db, publicUrl('/fr/not-found'))).toBeNull()
    await page('error-article', '404', 'An article about HTTP errors')
    await translate('error-article', '404', 'Article sur les erreurs HTTP')
    await publishDraftSite(testDb.db, null, uploadsDir, { variants: [{ rowId: 'error-article', localeId: fr }] })
    expect(await html('/fr/404')).toContain('Article sur les erreurs HTTP')
    const stillMissing = await renderNotFoundResponse(testDb.db, publicUrl('/fr/missing'), uploadsDir)
    expect(stillMissing?.status).toBe(404)
    expect(await stillMissing!.text()).toContain('Page introuvable')
    await updateLocale(testDb.db, fr, { enabled: false })
    await bumpPublishVersionSerialized()
    expect(await renderNotFoundResponse(testDb.db, publicUrl('/fr/missing'), uploadsDir)).toBeNull()
    const primary = await renderNotFoundResponse(testDb.db, publicUrl('/missing'), uploadsDir)
    expect(primary?.status).toBe(404)
    expect(await primary!.text()).toContain('Not found source')
  })
})
