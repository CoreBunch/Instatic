/**
 * CollabDocSet — the doc registry handed to the patch translator. The store
 * layer (client) and tests own the instances; `ensure` lazily creates a doc
 * for client-created rows (brand-new content — single author, no double-seed
 * risk; see seed.ts).
 */
import * as Y from 'yjs'

export interface CollabDocSet {
  get(docId: string): Y.Doc | undefined
  ensure(docId: string): Y.Doc
  /** Adopt an externally-owned doc (provider-bound) under this id. */
  set(docId: string, doc: Y.Doc): void
  delete(docId: string): void
  entries(): IterableIterator<[string, Y.Doc]>
}

export function createCollabDocSet(): CollabDocSet {
  const docs = new Map<string, Y.Doc>()
  return {
    get: (docId) => docs.get(docId),
    ensure: (docId) => {
      let doc = docs.get(docId)
      if (!doc) {
        doc = new Y.Doc()
        docs.set(docId, doc)
      }
      return doc
    },
    set: (docId, doc) => {
      docs.set(docId, doc)
    },
    delete: (docId) => {
      docs.get(docId)?.destroy()
      docs.delete(docId)
    },
    entries: () => docs.entries(),
  }
}
