import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import { create } from 'mutative'
import {
  createCollabDocSet, seedPageDoc, seedSiteDoc, applySitePatchesToDocs, projectPageDoc, metaMap, LOCAL_ORIGIN,
} from '@core/collab'
import { pageToCells } from '@core/data/pageFromRow'
import { validateGuardedUpdate } from '../../../server/collab/updateGuard'
import { mergeDerivedCells } from '../../../server/collab/relayPersistence'
import { makePage, makeSite } from '../fixtures'

describe('native collaborative page SEO', () => {
  it('converges with an independent remote edit, persists cells, and undoes only the local SEO change', () => {
    const page = makePage({ id: 'p1', title: 'Initial' })
    const site = makeSite({ pages: [page] })
    const docs = createCollabDocSet()
    seedSiteDoc(docs.ensure('site:main'), site)
    const local = docs.ensure('page:main:p1')
    seedPageDoc(local, page)
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local))
    const localBefore = Y.encodeStateVector(local)
    const remoteBefore = Y.encodeStateVector(remote)
    const undo = new Y.UndoManager(metaMap(local), { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    const [next, patches] = create(site, (draft) => {
      draft.pages[0].seo = { title: 'Authored', canonical: '/canonical', structuredData: [{ '@type': 'WebSite', name: 'Authored' }] }
    }, { enablePatches: true })
    applySitePatchesToDocs(patches, site, next, docs, LOCAL_ORIGIN, 'main')
    remote.transact(() => metaMap(remote).set('title', 'Remote display title'))
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local, localBefore))
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, remoteBefore))
    const projected = projectPageDoc(local, 'p1')
    expect(projectPageDoc(remote, 'p1')).toEqual(projected)
    expect(projected.title).toBe('Remote display title')
    expect(projected.seo).toEqual(next.pages[0].seo)
    const derived = pageToCells(projected)
    expect(mergeDerivedCells({ pluginField: 'Preserved', seoTitle: 'Old' }, derived, Object.keys(derived))).toMatchObject({ pluginField: 'Preserved', seoTitle: 'Authored', seoCanonical: '/canonical' })
    undo.undo()
    expect(projectPageDoc(local, 'p1').seo).toBeUndefined()
    expect(projectPageDoc(local, 'p1').title).toBe('Remote display title')
    expect(pageToCells(projectPageDoc(local, 'p1')).seoStructuredData).toBe('')
    undo.destroy(); local.destroy(); remote.destroy()
  })
  it('enforces the existing content capability for SEO changes through the real relay guard', () => {
    const doc = new Y.Doc()
    seedPageDoc(doc, makePage({ id: 'p1' }))
    const fork = new Y.Doc()
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
    const before = Y.encodeStateVector(doc)
    metaMap(fork).set('seo', { title: 'Metadata title' })
    const update = Y.encodeStateAsUpdate(fork, before)
    expect(validateGuardedUpdate('page:main:p1', doc, update, ['site.content.edit'])).toEqual({ ok: true })
    expect(validateGuardedUpdate('page:main:p1', doc, update, ['site.style.edit'])).toMatchObject({ ok: false, reason: expect.stringContaining('content') })
    expect(validateGuardedUpdate('page:main:p1', doc, update, ['site.structure.edit'])).toMatchObject({ ok: false })
    const languageFork = new Y.Doc()
    Y.applyUpdate(languageFork, Y.encodeStateAsUpdate(doc))
    metaMap(languageFork).set('language', 'fr')
    const languageUpdate = Y.encodeStateAsUpdate(languageFork, before)
    expect(validateGuardedUpdate('page:main:p1', doc, languageUpdate, ['site.structure.edit'])).toEqual({ ok: true })
    expect(validateGuardedUpdate('page:main:p1', doc, languageUpdate, ['site.style.edit'])).toMatchObject({ ok: false })
    languageFork.destroy()
    doc.destroy(); fork.destroy()
  })
})
