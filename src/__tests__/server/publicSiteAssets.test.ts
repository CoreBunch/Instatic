import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import '../../../server/richtextSanitizer'
import type { SiteFile } from '@core/files/schemas'
import { parseSiteFileBlob, publicAssetRequestPath, publicAssetUrl } from '@core/files/publicAssets'
import { buildPublicFileReferences } from '@core/files/references'
import { interpolateTokens } from '@core/templates/tokenInterpolation'
import { resolveDynamicProps } from '@core/templates/dynamicBindings'
import {
  compilePublicSiteAssets, publicSiteAssetResponse, readPublicSiteAsset, writePublicSiteAssets,
} from '../../../server/publish/publicSiteAssets'
import { prepareInactiveSlot, readArtefact, swapSlot, writeArtefact, writeStaticAsset } from '../../../server/publish/staticArtefact'
import { readPublicFilePreview, registerPublicFilePreview, resetPublicFilePreviews } from '../../../server/publish/publicFilePreview'

function asset(path = 'public/manifest.webmanifest', content = '{"name":"Site"}', mimeType = 'application/manifest+json'): SiteFile {
  return { id: path, path, type: 'asset', blob: { mimeType, base64: Buffer.from(content).toString('base64') }, createdAt: 1, updatedAt: 1 }
}

const directories: string[] = []
async function uploads(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'public-site-assets-'))
  directories.push(dir)
  return dir
}
afterEach(async () => {
  resetPublicFilePreviews()
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('native public file contract', () => {
  it('encodes filenames exactly once and allows passive data without a suffix', () => {
    expect(publicAssetUrl('public/files/logo 100%.png')).toBe('/files/logo%20100%25.png')
    expect(publicAssetUrl('public/.well-known/security.txt')).toBe('/.well-known/security.txt')
    expect(publicAssetRequestPath('/files/logo%20100%25.png')).toBe('/files/logo%20100%25.png')
    expect(compilePublicSiteAssets([asset('public/settings')])[0].mimeType).toBe('application/manifest+json')
  })

  it.each(['public/../secret', 'public//logo.png', 'public/logo.png/', 'public/CON.png', 'public/file:stream',
    'public/a\\b', 'public/a\u0000b', 'public/name.', 'src/files/icon.png', 'public/index.html', 'public/nested/about.HTML',
    'public/admin/icon.png', 'public/api/data', 'public/assets/icon.png', 'public/uploads/file', 'public/_instatic/file', 'public/health'])(
  'rejects unsafe, nonportable or server-owned path %s', (path) => {
    expect(() => publicAssetUrl(path)).toThrow()
  })

  it.each(['/x%2fy', '/%2e%2e/secret', '/bad%ZZ', '/foo//bar', '/admin/file', '/uploads/file'])(
  'rejects request aliases that escape the public-file contract: %s', (path) => {
    expect(publicAssetRequestPath(path)).toBeNull()
  })

  it.each(['A', 'AA', 'AA=', 'AB==', 'YWJj\n', 'abc==', '-___', 'Zm9v==='])('rejects corrupt/noncanonical base64 %s', (base64) => {
    expect(() => parseSiteFileBlob({ mimeType: 'text/plain', base64 }, 'public/file')).toThrow()
  })

  it.each(['text/html', 'application/xhtml+xml', 'text/css', 'application/x-javascript', 'text/javascript1.5',
    'text/plain\r\nx-secret: leak', 'image/png, text/html'])('rejects executable or unsafe MIME %s', (mimeType) => {
    expect(() => parseSiteFileBlob({ mimeType, base64: '' }, 'public/file')).toThrow()
  })

  it('rejects incomplete payloads, URL/page collisions and file/directory collisions', () => {
    const empty = { ...asset(), blob: undefined }
    expect(() => compilePublicSiteAssets([empty])).toThrow('no binary payload')
    expect(() => compilePublicSiteAssets([asset('public/data')], ['/data'])).toThrow('collides')
    expect(() => compilePublicSiteAssets([asset('public/data')], ['/data/entry'])).toThrow('collides')
    expect(() => compilePublicSiteAssets([asset('public/Data'), asset('public/data')])).toThrow('collides')
    expect(() => compilePublicSiteAssets([asset('public/café'), asset('public/cafe\u0301')])).toThrow('collides')
    expect(() => compilePublicSiteAssets([asset('public/data'), asset('public/data/file')])).toThrow('directory')
  })

  it('publishes only binary assets, keeping config/doc/script text private', () => {
    const files: SiteFile[] = ['config', 'doc', 'script', 'style', 'component'].map((type) => ({
      ...asset(), id: type, type: type as SiteFile['type'], content: 'private', blob: undefined,
    }))
    expect(compilePublicSiteAssets(files)).toEqual([])
  })

  it('sanitizes SVG before computing identity, retaining geometry and removing executable siblings', () => {
    const [compiled] = compilePublicSiteAssets([asset('public/icon.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/><script>alert(1)</script><foreignObject/><path onclick="evil()" d="M1 1"/></svg>', 'image/svg+xml')])
    const clean = new TextDecoder().decode(compiled.bytes)
    expect(clean).toContain('M0 0h10v10z')
    expect(clean).toContain('M1 1')
    expect(clean).not.toMatch(/script|foreignObject|onclick/)
    expect(compiled.byteLength).toBe(compiled.bytes.byteLength)
  })

  it('resolves typed file bindings with distinct published and private preview URLs', () => {
    const file = { ...asset('public/icon.png', 'image', 'image/png'), id: 'icon' }
    const files = buildPublicFileReferences([file])
    expect(interpolateTokens('{file.icon.url}', { entryStack: [], files })).toBe('/icon.png')
    const preview = registerPublicFilePreview('owner', [file], 100)
    expect(resolveDynamicProps({ src: '' }, { src: { source: 'file', field: 'icon.url', format: 'media' } }, { entryStack: [], files: preview }).src)
      .toBe(preview.icon.url)
    expect(readPublicFilePreview('owner', preview.icon.url, 101)?.mimeType).toBe('image/png')
    expect(readPublicFilePreview('other-owner', preview.icon.url, 101)).toBeNull()
    expect(readPublicFilePreview('owner', preview.icon.url, 100 + 15 * 60 * 1000)).toBeNull()
    expect(files.icon.url).toBe('/icon.png')
  })

  it('preserves literal dotted IDs and own prototype-named IDs in the shared binding frame', () => {
    const files = buildPublicFileReferences([
      { ...asset('public/dotted.json'), id: 'file.with.dots' },
      { ...asset('public/prototype.json'), id: '__proto__' },
    ])
    expect(interpolateTokens('{file.file.with.dots.url}', { entryStack: [], files })).toBe('/dotted.json')
    expect(interpolateTokens('{file.__proto__.url}', { entryStack: [], files })).toBe('/prototype.json')
    expect(() => interpolateTokens('{file.constructor.name}', { entryStack: [], files })).toThrow('does not exist')
    expect(Object.hasOwn(files, '__proto__')).toBe(true)
  })
})

describe('public assets share a static generation', () => {
  it('emits exact bytes and declared MIME, including extensionless assets; only indexed files are readable', async () => {
    const dir = await uploads()
    const { slot, slotDir } = await prepareInactiveSlot(dir)
    const source = asset('public/settings', '{"v":1}', 'application/json; charset=utf-8')
    await writeArtefact(slotDir, '/', '<html>home</html>')
    await writeStaticAsset(slotDir, '/private.dat', new TextEncoder().encode('not indexed'))
    await writePublicSiteAssets(slotDir, compilePublicSiteAssets([source]))
    await swapSlot(dir, slot)
    const result = await readPublicSiteAsset(dir, '/settings')
    expect(new TextDecoder().decode(result!.bytes)).toBe('{"v":1}')
    expect(result!.mimeType).toBe('application/json; charset=utf-8')
    expect(await readFile(join(slotDir, 'settings'), 'utf-8')).toBe('{"v":1}')
    expect(await readArtefact(dir, '/')).toBe('<html>home</html>')
    expect(await readPublicSiteAsset(dir, '/private.dat')).toBeNull()
    expect(await readPublicSiteAsset(dir, '/_instatic/public-assets.json')).toBeNull()
  })

  it('revalidates stable URLs and updates MIME/hash/deletions on the pointer swap', async () => {
    const dir = await uploads()
    const first = await prepareInactiveSlot(dir)
    await writePublicSiteAssets(first.slotDir, compilePublicSiteAssets([asset('public/config', 'old', 'text/plain')]))
    await swapSlot(dir, first.slot)
    const oldAsset = (await readPublicSiteAsset(dir, '/config'))!
    const response = publicSiteAssetResponse(new Request('http://localhost/config'), oldAsset)
    expect(await response.text()).toBe('old')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const etag = response.headers.get('etag')!
    const cached = publicSiteAssetResponse(new Request('http://localhost/config', { headers: { 'if-none-match': `W/${etag}` } }), oldAsset)
    expect(cached.status).toBe(304)
    const head = publicSiteAssetResponse(new Request('http://localhost/config', { method: 'HEAD' }), oldAsset)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe('3')
    const next = await prepareInactiveSlot(dir)
    await writePublicSiteAssets(next.slotDir, compilePublicSiteAssets([asset('public/config', '{"new":1}', 'application/json')]))
    await swapSlot(dir, next.slot)
    const current = (await readPublicSiteAsset(dir, '/config'))!
    expect(current.mimeType).toBe('application/json')
    expect(current.sha256).not.toBe(oldAsset.sha256)
    expect(publicSiteAssetResponse(new Request('http://localhost/config', { headers: { 'if-none-match': etag } }), current).status).toBe(200)
    const removed = await prepareInactiveSlot(dir)
    await writePublicSiteAssets(removed.slotDir, [])
    await swapSlot(dir, removed.slot)
    expect(await readPublicSiteAsset(dir, '/config')).toBeNull()
  })

  it('fails explicitly for corrupt metadata and rejects mismatched bytes', async () => {
    const dir = await uploads()
    const { slot, slotDir } = await prepareInactiveSlot(dir)
    await writePublicSiteAssets(slotDir, compilePublicSiteAssets([asset()]))
    await swapSlot(dir, slot)
    await writeFile(join(slotDir, 'manifest.webmanifest'), 'different')
    expect(await readPublicSiteAsset(dir, '/manifest.webmanifest')).toBeNull()
    await writeFile(join(slotDir, '_instatic/public-assets.json'), '{"/manifest.webmanifest":{"mimeType":42}}')
    expect(readPublicSiteAsset(dir, '/manifest.webmanifest')).rejects.toThrow('index is invalid')
  })

  it('keeps metadata and bytes matched while multiple generations swap', async () => {
    const dir = await uploads()
    for (let index = 0; index < 2; index++) {
      const { slot, slotDir } = await prepareInactiveSlot(dir)
      await writePublicSiteAssets(slotDir, compilePublicSiteAssets([asset('public/data', `generation ${index}`, index % 2 ? 'application/json' : 'text/plain')]))
      await swapSlot(dir, slot)
    }
    const writer = (async () => {
      for (let index = 2; index < 20; index++) {
        const { slot, slotDir } = await prepareInactiveSlot(dir)
        await writePublicSiteAssets(slotDir, compilePublicSiteAssets([asset('public/data', `generation ${index}`, index % 2 ? 'application/json' : 'text/plain')]))
        await swapSlot(dir, slot)
      }
    })()
    const reader = (async () => {
      for (let index = 0; index < 60; index++) {
        const result = await readPublicSiteAsset(dir, '/data')
        expect(result).not.toBeNull()
        const generation = Number(new TextDecoder().decode(result!.bytes).split(' ')[1])
        expect(result!.mimeType).toBe(generation % 2 ? 'application/json' : 'text/plain')
      }
    })()
    await Promise.all([writer, reader])
  })
})
