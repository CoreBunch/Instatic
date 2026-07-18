import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSiteRuntime, loadArtifactManifest } from './runtime'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'instatic-site-runtime-'))
  tempDirs.push(dir)
  await mkdir(join(dir, '.instatic'), { recursive: true })
  await mkdir(join(dir, 'assets'), { recursive: true })
  const manifest = {
    schemaVersion: 1 as const,
    artifactId: 'artifact-1',
    siteId: 'site-1',
    publishedAt: '2026-01-01T00:00:00.000Z',
    publishVersion: 1,
    routes: [
      { path: '/', file: 'index.html', kind: 'page' as const },
      { path: '/about', file: 'about.html', kind: 'page' as const },
      { path: '/404', file: '404.html', kind: 'notFound' as const },
    ],
    uploadedFiles: [],
    deployment: {
      mode: 'static' as const,
      portable: true,
      requirements: [] as Array<{ code: string; message: string }>,
    },
  }
  await Promise.all([
    writeFile(join(dir, '.instatic', 'site-artifact.json'), JSON.stringify(manifest)),
    writeFile(join(dir, 'index.html'), '<h1>Home</h1>'),
    writeFile(join(dir, 'about.html'), '<h1>About</h1>'),
    writeFile(join(dir, '404.html'), '<h1>Missing</h1>'),
    writeFile(join(dir, 'assets', 'app.js'), 'console.log("ok")'),
  ])
  return { dir, manifest }
}

describe('site-only runtime', () => {
  it('loads a supported artifact and serves pages, assets, and health', async () => {
    const { dir } = await fixture()
    const manifest = await loadArtifactManifest(dir)
    const fetch = createSiteRuntime({ artifactDir: dir, manifest })

    expect(await (await fetch(new Request('http://site.test/'))).text()).toContain('Home')
    expect(await (await fetch(new Request('http://site.test/about/'))).text()).toContain('About')
    const asset = await fetch(new Request('http://site.test/assets/app.js'))
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const health = await fetch(new Request('http://site.test/health'))
    expect(await health.json()).toEqual({ ok: true, artifactId: 'artifact-1', portable: true })
  })

  it('never exposes the private manifest or an admin surface', async () => {
    const { dir, manifest } = await fixture()
    await mkdir(join(dir, 'admin'), { recursive: true })
    await writeFile(join(dir, 'admin', 'secret.js'), 'builder-secret')
    const fetch = createSiteRuntime({ artifactDir: dir, manifest })

    const manifestResponse = await fetch(new Request('http://site.test/.instatic/site-artifact.json'))
    expect(manifestResponse.status).toBe(404)
    expect(await manifestResponse.text()).toContain('Missing')
    expect((await fetch(new Request('http://site.test/admin'))).status).toBe(404)
    const adminAsset = await fetch(new Request('http://site.test/admin/secret.js'))
    expect(adminAsset.status).toBe(404)
    expect(await adminAsset.text()).not.toContain('builder-secret')
  })

  it('rejects an artifact manifest that can escape the public directory', async () => {
    const { dir, manifest } = await fixture()
    manifest.routes[0]!.file = '../private.txt'
    await writeFile(join(dir, '.instatic', 'site-artifact.json'), JSON.stringify(manifest))

    expect(loadArtifactManifest(dir)).rejects.toThrow('invalid or unsupported')
  })

  it('returns an explicit error for a dynamic endpoint in an incomplete export', async () => {
    const { dir, manifest } = await fixture()
    manifest.deployment.portable = false
    manifest.deployment.requirements = [{ code: 'cms-forms', message: 'Forms need a service.' }]
    const fetch = createSiteRuntime({ artifactDir: dir, manifest })

    const response = await fetch(new Request('http://site.test/_instatic/form/submit'))
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ requirements: manifest.deployment.requirements })
  })

  it('supports byte ranges for exported media', async () => {
    const { dir, manifest } = await fixture()
    await mkdir(join(dir, 'uploads'), { recursive: true })
    await writeFile(join(dir, 'uploads', 'clip.mp4'), '0123456789')
    const fetch = createSiteRuntime({ artifactDir: dir, manifest })

    const response = await fetch(new Request('http://site.test/uploads/clip.mp4', {
      headers: { range: 'bytes=2-5' },
    }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await response.text()).toBe('2345')
  })
})
