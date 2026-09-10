/** The live manifest gates disk before expensive snapshot hydration/rendering. */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return readFile(join(ROOT, relative), 'utf-8')
}

describe('static-artefact-served-before-render', () => {
  it('visibility is resolved before disk and disk is read before snapshot hydration', async () => {
    const source = await read('server/publish/publicRouter.ts')

    const visibility = source.indexOf('const route = resolvePublishedRoute(')
    const artefact = source.indexOf('await readArtefact(')
    const hydration = source.indexOf('await readPublishedRouteContext(')
    expect(visibility).toBeGreaterThan(-1)
    expect(artefact).toBeGreaterThan(visibility)
    expect(hydration).toBeGreaterThan(artefact)
    expect(source).toContain('arePublishedArtefactsCurrent()')
  })

  it('readArtefact is imported in publicRouter.ts from staticArtefact', async () => {
    const source = await read('server/publish/publicRouter.ts')
    // The import must name staticArtefact as the source
    expect(source).toMatch(/import\s*\{[^}]*readArtefact[^}]*\}\s*from\s*['"]\.\/staticArtefact['"]/)
  })

  it('the disk fast-path is gated on the canonical (render-affecting) query being empty', async () => {
    const source = await read('server/publish/publicRouter.ts')
    // The guard gates on the canonicalised query — junk params canonicalise to
    // '' and serve the artefact; only render-affecting (loop pagination) params
    // fall through to the live renderer (ISS-032).
    expect(source).toContain('canonicalRenderQuery(url.searchParams)')
    expect(source).toContain("queryString === ''")
  })

  it('the disk path does not call applyPublishedHtmlPipeline at request time', async () => {
    const source = await read('server/publish/publicRouter.ts')
    const artefactReturn = source.indexOf('return new Response(html,')
    const pipeline = source.indexOf('applyPublishedHtmlPipeline(')
    expect(artefactReturn).toBeGreaterThan(-1)
    expect(pipeline).toBeGreaterThan(artefactReturn)
  })
})
