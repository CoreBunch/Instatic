import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PublicFormIdentity } from '@core/forms'
import type { Page } from '@core/page-tree'
import { makePage, makeSite } from '../publisher/helpers'
import { makeVC } from '../fixtures'
import { cleanupPublishingTestDbs, createPublishingTestDb } from '../helpers/publishingTestDb'
import { createLocale } from '../../../server/repositories/localization'
import { createDataRow, createDataTable, getDataRow, updateDataRowStatus } from '../../../server/repositories/data'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { publishDataRow } from '../../../server/publish/publishRow'
import { loadPublishedRouteInventory } from '../../../server/publish/publishedRoutes'
import { findPublishedFormSnapshot } from '../../../server/forms/publishedFormSnapshot'
import { issuePublicFormPageToken, resetPublicFormChallenges, verifyPublicFormPageToken } from '../../../server/forms/challenge'
import { handlePublicFormRequest } from '../../../server/forms/handler'
import { resetForTests } from '../../../server/publish/renderCache'
import { renderPublicResolution } from '../../../server/publish/publicRouter'
import { resetPublicOrigins } from '../../../server/auth/security'
import * as rateLimits from '../../../server/forms/rateLimit'

beforeEach(() => {
  resetForTests()
  resetPublicOrigins()
  resetPublicFormChallenges()
  for (const limit of Object.values(rateLimits)) limit.reset()
})
afterEach(cleanupPublishingTestDbs)

async function fixture(kind: 'page' | 'component' | 'entry' = 'page') {
  const form = makePage({
    form: { moduleId: 'base.form', props: { mode: 'cms', formId: 'contact', targetTableId: 'submissions', minSubmitSeconds: 0 }, children: ['email', 'hidden'] },
    email: { moduleId: 'base.input', props: { fieldId: 'email', name: 'email', inputType: 'email', required: true } },
    hidden: { moduleId: 'base.input', props: { fieldId: 'private', name: 'private', required: true }, hidden: true },
  })
  form.rootNodeId = 'form'
  form.id = 'contact'
  form.slug = 'contact'
  const page: Page = kind === 'component' ? { ...makePage({ root: { moduleId: 'base.visual-component-ref', props: { componentId: 'contact-component' } } }), id: 'contact', slug: 'contact' } : form
  if (kind === 'entry') page.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 }
  const site = makeSite({ pages: [page], visualComponents: kind === 'component' ? [makeVC({ id: 'contact-component', name: 'Contact', tree: { nodes: form.nodes, rootNodeId: 'form' } })] : [] })
  const db = await createPublishingTestDb(site, false)
  await createDataTable(db, { id: 'submissions', name: 'Submissions', slug: 'submissions', kind: 'data', singularLabel: 'Submission', pluralLabel: 'Submissions', fields: [{ id: 'email', label: 'Email', type: 'email', required: true }] })
  const locale = await createLocale(db, { code: 'fr', name: 'Français', pathPrefix: 'fr', enabled: true, direction: 'ltr' })
  await publishDraftSite(db, null, undefined, { variants: [{ rowId: 'contact', localeId: locale.id }] })
  if (kind === 'entry') {
    await createDataRow(db, { id: 'article', tableId: 'posts', slug: 'article', cells: { title: 'Article', body: 'Article body' } })
    await publishDataRow(db, 'article', null, undefined, { localeId: locale.id })
  }
  const route = (await loadPublishedRouteInventory(db)).routes[0]
  const identity: PublicFormIdentity = { pageId: route.contentId, localeId: route.localeId, publishedVersionId: route.publishedVersionId, pagePath: route.path, formId: 'contact' }
  return { db, identity }
}

async function request(db: Awaited<ReturnType<typeof fixture>>['db'], kind: 'challenge' | 'submit', payload: Record<string, unknown>) {
  const url = new URL(`http://forms.test/_instatic/form/${kind}`)
  const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  req.headers.set('origin', url.origin)
  req.headers.set('sec-fetch-site', 'same-origin')
  return (await handlePublicFormRequest(req, db, url))!
}

describe('published form language identity', () => {
  it('accepts an independently online translated form and stores its language', async () => {
    const { db, identity } = await fixture()
    const htmlResponse = await renderPublicResolution(db, new URL(`http://forms.test${identity.pagePath}`))
    const html = await htmlResponse!.text()
    expect(html).toContain(`data-instatic-locale-id="${identity.localeId}"`)
    expect(html).toContain(`data-instatic-published-version-id="${identity.publishedVersionId}"`)
    const snapshot = await findPublishedFormSnapshot(db, identity)
    expect(snapshot?.controls.map((control) => control.fieldId)).toEqual(['email'])
    const challengeResponse = await request(db, 'challenge', { ...identity, pageToken: issuePublicFormPageToken(identity) })
    expect(challengeResponse.status).toBe(200)
    const challenge = await challengeResponse.json()
    const submitted = await request(db, 'submit', { ...identity, ...challenge, values: { email: 'reader@example.test' } })
    expect(submitted.status).toBe(200)
    const result = await submitted.json()
    expect((await getDataRow(db, result.rowId, identity.localeId))?.localeId).toBe(identity.localeId)
    expect(await findPublishedFormSnapshot(db, { ...identity, localeId: 'default', pagePath: '/contact' })).toBeNull()
  })

  it('resolves a visible localized component form and revokes it on retraction', async () => {
    const { db, identity } = await fixture('component')
    expect((await findPublishedFormSnapshot(db, identity))?.controls).toHaveLength(1)
    const challengeResponse = await request(db, 'challenge', { ...identity, pageToken: issuePublicFormPageToken(identity) })
    const challenge = await challengeResponse.json()
    await updateDataRowStatus(db, identity.pageId, 'unpublished', null, identity.localeId)
    expect(await findPublishedFormSnapshot(db, identity)).toBeNull()
    const submitted = await request(db, 'submit', { ...identity, ...challenge, values: { email: 'reader@example.test' } })
    expect(submitted.status).toBe(404)
  })

  it('binds a CMS form to its live item while retaining the frozen template dependency', async () => {
    const { db, identity } = await fixture('entry')
    expect(identity.pageId).toBe('article')
    expect(identity.pagePath).toBe('/fr/posts/article')
    await updateDataRowStatus(db, 'contact', 'unpublished', null, identity.localeId)
    const response = await renderPublicResolution(db, new URL(`http://forms.test${identity.pagePath}`))
    expect(await response!.text()).toContain('data-instatic-page-id="article"')
    const challengeResponse = await request(db, 'challenge', { ...identity, pageToken: issuePublicFormPageToken(identity) })
    expect(challengeResponse.status).toBe(200)
    const challenge = await challengeResponse.json()
    expect((await request(db, 'submit', { ...identity, ...challenge, values: { email: 'reader@example.test' } })).status).toBe(200)
    expect(await findPublishedFormSnapshot(db, { ...identity, pageId: 'contact' })).toBeNull()
    await updateDataRowStatus(db, identity.pageId, 'unpublished', null, identity.localeId)
    expect(await findPublishedFormSnapshot(db, identity)).toBeNull()
  })

  it('binds form tokens to the exact language, path, logical content and release', async () => {
    const { db, identity } = await fixture()
    const pageToken = issuePublicFormPageToken(identity)
    for (const patch of [{ localeId: 'default' }, { pagePath: '/contact' }, { pageId: 'other' }, { publishedVersionId: 'other' }]) {
      expect(verifyPublicFormPageToken({ ...identity, ...patch, pageToken })).toBe(false)
    }
    await publishDraftSite(db, null, undefined, { variants: [{ rowId: identity.pageId, localeId: identity.localeId }] })
    expect(await findPublishedFormSnapshot(db, identity)).toBeNull()
    expect((await request(db, 'challenge', { ...identity, pageToken })).status).toBe(404)
  })
})
