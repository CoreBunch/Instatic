/**
 * Granular shell files — the shell's `files` key is a per-file Y.Map with
 * `content` as Y.Text, so code files co-edit with the same guarantees as
 * canvas text: different files never collide, one file's content merges
 * character-level, and a delete of one file can't clobber a neighbour's
 * concurrent edit. This is what the site editor's code panel and the
 * Plugin IDE both ride.
 */
import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import { create } from 'mutative'
import '@modules/base'
import {
  applySitePatchesToDocs,
  createCollabDocSet,
  projectSiteDoc,
  seedSiteDoc,
  shellMap,
  siteFileContentText,
  SITE_DOC_ID,
} from '@core/collab'
import type { SiteDocument } from '@core/page-tree'
import type { SiteFile } from '@core/files/schemas'
import { makeSite } from '../fixtures'

const file = (id: string, path: string, content: string, createdAt = 1): SiteFile => ({
  id,
  path,
  type: 'script',
  content,
  createdAt,
  updatedAt: createdAt,
})

function siteWithFiles(): SiteDocument {
  return makeSite({
    files: [
      file('f1', 'src/scripts/a.ts', 'const a = 1\n', 1),
      file('f2', 'src/scripts/b.ts', 'const b = 2\n', 2),
    ],
  })
}

function seededPair(site: SiteDocument): [Y.Doc, Y.Doc] {
  const a = new Y.Doc()
  seedSiteDoc(a, site)
  const b = new Y.Doc()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  return [a, b]
}

function syncDocs(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

/** Run one store-style mutation through the patch translator against `doc`. */
function mutateThroughPatches(
  doc: Y.Doc,
  site: SiteDocument,
  recipe: (draft: SiteDocument) => void,
): SiteDocument {
  const [next, patches] = create(site, recipe, { enablePatches: true })
  const docs = createCollabDocSet()
  docs.set(SITE_DOC_ID, doc)
  applySitePatchesToDocs(patches, site, next, docs, 'test-local')
  return next
}

function projectedFiles(doc: Y.Doc): SiteFile[] {
  return projectSiteDoc(doc).shell['files'] as SiteFile[]
}

describe('granular shell files', () => {
  it('seed + project round-trips the files array', () => {
    const site = siteWithFiles()
    const [a] = seededPair(site)
    expect(projectedFiles(a)).toEqual(site.files)
  })

  it('content edits translate to Y.Text splices that merge character-level', () => {
    const site = siteWithFiles()
    const [a, b] = seededPair(site)

    mutateThroughPatches(a, site, (draft) => {
      draft.files[0]!.content = '// top\nconst a = 1\n'
    })
    mutateThroughPatches(b, site, (draft) => {
      draft.files[0]!.content = 'const a = 1\n// bottom\n'
    })
    syncDocs(a, b)

    const merged = projectedFiles(a).find((f) => f.id === 'f1')!.content
    expect(merged).toContain('// top')
    expect(merged).toContain('// bottom')
    expect(merged).toContain('const a = 1')
    expect(projectedFiles(b).find((f) => f.id === 'f1')!.content).toBe(merged)
  })

  it('deleting one file never clobbers a concurrent edit to another', () => {
    const site = siteWithFiles()
    const [a, b] = seededPair(site)

    // Peer A deletes f1 (shifts f2 to index 0 — Mutative emits replace ops
    // for the shifted entry); peer B concurrently edits f2's content.
    mutateThroughPatches(a, site, (draft) => {
      draft.files.splice(0, 1)
    })
    mutateThroughPatches(b, site, (draft) => {
      draft.files[1]!.content = 'const b = 2\n// edited\n'
    })
    syncDocs(a, b)

    for (const doc of [a, b]) {
      const files = projectedFiles(doc)
      expect(files.map((f) => f.id)).toEqual(['f2'])
      expect(files[0]!.content).toContain('// edited')
    }
  })

  it('adding files on both peers keeps both', () => {
    const site = siteWithFiles()
    const [a, b] = seededPair(site)

    mutateThroughPatches(a, site, (draft) => {
      draft.files.push(file('f3', 'src/scripts/c.ts', 'const c = 3\n', 3))
    })
    mutateThroughPatches(b, site, (draft) => {
      draft.files.push(file('f4', 'src/scripts/d.ts', 'const d = 4\n', 4))
    })
    syncDocs(a, b)

    for (const doc of [a, b]) {
      expect(projectedFiles(doc).map((f) => f.id)).toEqual(['f1', 'f2', 'f3', 'f4'])
    }
  })

  it('renames merge with concurrent content edits to the same file', () => {
    const site = siteWithFiles()
    const [a, b] = seededPair(site)

    mutateThroughPatches(a, site, (draft) => {
      draft.files[0]!.path = 'src/scripts/renamed.ts'
    })
    mutateThroughPatches(b, site, (draft) => {
      draft.files[0]!.content = 'const a = 1\n// note\n'
    })
    syncDocs(a, b)

    const merged = projectedFiles(a).find((f) => f.id === 'f1')!
    expect(merged.path).toBe('src/scripts/renamed.ts')
    expect(merged.content).toContain('// note')
  })

  it('siteFileContentText exposes the live Y.Text for editor bindings', () => {
    const site = siteWithFiles()
    const [a] = seededPair(site)
    const text = siteFileContentText(shellMap(a), 'f1')
    expect(text).toBeInstanceOf(Y.Text)
    expect(text!.toString()).toBe('const a = 1\n')
    expect(siteFileContentText(shellMap(a), 'nope')).toBeNull()
  })

  it('legacy LWW-array layout projects as-is and upgrades on first write', () => {
    const site = siteWithFiles()
    const doc = new Y.Doc()
    seedSiteDoc(doc, { ...site, files: [] })
    // Simulate a pre-granular doc: plain array value under 'files'.
    doc.transact(() => {
      shellMap(doc).set('files', site.files)
    })
    expect(projectedFiles(doc)).toEqual(site.files)

    mutateThroughPatches(doc, site, (draft) => {
      draft.files[0]!.content = 'upgraded\n'
    })
    expect(shellMap(doc).get('files')).toBeInstanceOf(Y.Map)
    expect(projectedFiles(doc).find((f) => f.id === 'f1')!.content).toBe('upgraded\n')
  })
})
