/**
 * Architecture gate: `tryServeModuleJsAsset` must be registered in
 * `server/router.ts` BEFORE `tryServePublicRoute`, mirroring
 * `hole-runtime-asset-route.test.ts`. If the handler is missing or appears
 * after the public resolver, `/_instatic/module-js/...` requests would be
 * swallowed by the public-slug lookup and 404 as a page miss instead of
 * being answered by the module-JS asset handler.
 */
import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('module-js asset route ordering', () => {
  it('router registers tryServeModuleJsAsset', async () => {
    const source = await read('server/router.ts')
    expect(source).toContain('tryServeModuleJsAsset')
  })

  it('tryServeModuleJsAsset appears BEFORE tryServePublicRoute in the route table', async () => {
    const source = await read('server/router.ts')
    const tableMatch = source.match(/const routes:\s*readonly[^=]*=\s*\[([\s\S]*?)\]/)
    expect(tableMatch).not.toBeNull()
    const table = tableMatch![1]

    const moduleJsIdx = table.indexOf('tryServeModuleJsAsset')
    const publicIdx = table.indexOf('tryServePublicRoute')
    expect(moduleJsIdx).toBeGreaterThan(-1)
    expect(publicIdx).toBeGreaterThan(-1)
    expect(moduleJsIdx).toBeLessThan(publicIdx)
  })

  it('module-js handler imports are wired from server/handlers/cms/moduleJs', async () => {
    const source = await read('server/router.ts')
    expect(source).toContain("from './handlers/cms/moduleJs'")
    expect(source).toContain('isModuleJsAssetPath')
    expect(source).toContain('handleModuleJsAssetRequest')
  })

  // The tag's `?v=` is the content hash of the script body. The publish
  // counter restarts at 0 on every boot, so stamping it would repeat a URL a
  // browser cached before a restart, with a different body behind it.
  it('the html pipeline never stamps publishVersion into module script tags', async () => {
    const pipeline = await read('server/publish/publishedHtmlPipeline.ts')
    expect(pipeline).not.toContain('publishVersion')
    const bundle = await read('server/publish/moduleJsBundle.ts')
    const inject = bundle.slice(bundle.indexOf('export function injectModuleScripts'))
    expect(inject).toContain('?v=${version}')
    expect(inject).not.toContain('publishVersion')
  })

  // One cache rule for every content-versioned script: long cache only under
  // the URL that names the body, `no-cache` otherwise, `ETag` + `304` on
  // both. A route that hand-rolls its headers drifts from it (the loop and
  // hole runtimes once sent `max-age=3600` whatever the URL said).
  it('the three versioned script routes answer through serveVersionedScript', async () => {
    for (const file of ['moduleJs.ts', 'loop.ts', 'hole.ts']) {
      const handler = await read(`server/handlers/cms/${file}`)
      expect(handler).toContain('serveVersionedScript(req, url,')
      expect(handler).not.toContain('max-age')
    }
  })

  // Both runtime tags carry their runtime's content hash, like module tags.
  it('the publisher stamps a version onto both runtime script tags', async () => {
    const render = await read('src/core/publisher/render.ts')
    expect(render).toContain('loop-runtime.js${runtimeVersionQuery(options.loopRuntimeVersion)}')
    expect(render).toContain('hole-runtime.js${runtimeVersionQuery(options.holeRuntimeVersion)}')
    const renderer = await read('server/publish/publicRenderer.ts')
    expect(renderer).toContain('holeRuntimeVersion: HOLE_RUNTIME_VERSION')
    expect(renderer).toContain('loopRuntimeVersion: LOOP_RUNTIME_VERSION')
  })
})
