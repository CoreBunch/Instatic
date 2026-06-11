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
})
