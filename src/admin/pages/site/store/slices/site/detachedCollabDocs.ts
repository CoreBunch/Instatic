import type * as Y from 'yjs'
import type { SiteDocument } from '@core/page-tree'
import {
  createCollabDocSet, encodeCollabDocId, seedComponentDoc, seedLayoutDoc,
  seedPageDoc, seedSiteDoc, siteDocId, type CollabDocSet,
} from '@core/collab'

/**
 * Detached rows retain their initial JSON until first use, rather than building
 * a second copy of every tree in Yjs before the provider connects. Keeping the
 * seed for unused rows also lets a roster undo restore an untouched deleted row.
 */
export function createDetachedCollabDocSet(
  site: SiteDocument,
  branchId: string,
  onCreate: (docId: string, doc: Y.Doc) => void,
): CollabDocSet {
  const docs = createCollabDocSet()
  const seeds = new Map<string, (doc: Y.Doc) => void>()
  seeds.set(siteDocId(branchId), (doc) => seedSiteDoc(doc, site))
  for (const page of site.pages) {
    seeds.set(encodeCollabDocId({ kind: 'page', branchId, rowId: page.id }), (doc) => seedPageDoc(doc, page))
  }
  for (const component of site.visualComponents) {
    seeds.set(encodeCollabDocId({ kind: 'component', branchId, rowId: component.id }), (doc) => seedComponentDoc(doc, component))
  }
  for (const layout of site.layouts) {
    seeds.set(encodeCollabDocId({ kind: 'layout', branchId, rowId: layout.id }), (doc) => seedLayoutDoc(doc, layout))
  }
  const ensure = (docId: string): Y.Doc => {
    const existing = docs.get(docId)
    if (existing) return existing
    const doc = docs.ensure(docId)
    seeds.get(docId)?.(doc)
    seeds.delete(docId)
    // Seed first so the initial content is outside the local undo history.
    onCreate(docId, doc)
    return doc
  }
  return {
    get: (docId) => docs.get(docId) ?? (seeds.has(docId) ? ensure(docId) : undefined),
    ensure,
    set: (docId, doc) => { seeds.delete(docId); docs.set(docId, doc) },
    delete: (docId) => { seeds.delete(docId); docs.delete(docId) },
    entries: () => docs.entries(),
  }
}
