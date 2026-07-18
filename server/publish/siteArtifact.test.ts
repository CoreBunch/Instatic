import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SiteDocument } from '@core/page-tree'
import type { MediaAsset } from '../repositories/media'
import {
  artifactFileForRoute,
  collectSiteArtifactMediaFiles,
  collectSiteArtifactUploadedFiles,
  createSiteArtifactManifest,
  detectSiteArtifactRequirements,
  materializeSiteArtifact,
} from './siteArtifact'

const site = { id: 'site-1' } as SiteDocument
const ROOT = join(import.meta.dir, '../..')
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function mediaAsset(overrides: Partial<MediaAsset & { storagePath: string }> = {}) {
  return {
    id: 'media-1',
    filename: 'hero.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 10,
    publicPath: '/uploads/hero.jpg',
    storagePath: 'hero.jpg',
    uploadedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    altText: '',
    caption: '',
    title: '',
    tags: [],
    width: 100,
    height: 100,
    durationMs: null,
    dominantColor: null,
    deletedAt: null,
    replacedAt: null,
    folderIds: [],
    blurHash: null,
    variants: [],
    posterPath: null,
    storageAdapterId: '',
    externallyHosted: false,
    ...overrides,
  } satisfies MediaAsset & { storagePath: string }
}

describe('site artifact manifest', () => {
  it('maps public routes to the existing static artifact file convention', () => {
    expect(artifactFileForRoute('/')).toBe('index.html')
    expect(artifactFileForRoute('/about')).toBe('about.html')
    expect(artifactFileForRoute('/docs/')).toBe('docs/index.html')
    expect(() => artifactFileForRoute('/../secret')).toThrow()
  })

  it('deduplicates routes and reports a portable static artifact', () => {
    const manifest = createSiteArtifactManifest({
      artifactId: 'publish-1',
      site,
      publishVersion: 3,
      pageRoutes: ['/', '/about', '/about'],
      contentRoutes: ['/posts/hello'],
      hasNotFoundRoute: true,
      htmlDocuments: ['<!doctype html><html><body>Static</body></html>'],
      moduleJsAssets: new Map(),
      mediaAssets: [],
      publishedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(manifest.routes).toEqual([
      { path: '/', file: 'index.html', kind: 'page' },
      { path: '/about', file: 'about.html', kind: 'page' },
      { path: '/posts/hello', file: 'posts/hello.html', kind: 'content' },
      { path: '/404', file: '404.html', kind: 'notFound' },
    ])
    expect(manifest.deployment).toEqual({ mode: 'static', portable: true, requirements: [] })
  })

  it('detects every server-dependent public feature', () => {
    const requirements = detectSiteArtifactRequirements(
      [
        '<script src="/_instatic/hole-runtime.js"></script>',
        '<script src="/_instatic/assets/loop-runtime.js"></script>',
        '<img src="/_instatic/media/acme/path">',
        '<script src="/uploads/plugins/example/1.0.0/site.js"></script>',
      ],
      new Map([['base.form', "fetch('/_instatic/form/submit')"]]),
      ['plugin-public-routes'],
    )
    expect(requirements.map((item) => item.code)).toEqual([
      'cms-forms',
      'dynamic-holes',
      'infinite-loops',
      'plugin-frontend-assets',
      'plugin-public-routes',
      'proxied-media',
    ])
  })

  it('collects only local media originals, variants, and posters', () => {
    const files = collectSiteArtifactMediaFiles([
      mediaAsset({
        variants: [{
          width: 50,
          height: 50,
          format: 'webp',
          path: '/uploads/hero-w50.webp',
          storagePath: 'hero-w50.webp',
          sizeBytes: 5,
          storageAdapterId: '',
        }],
        posterPath: 'hero-poster.jpg',
      }),
      mediaAsset({
        id: 'external',
        publicPath: 'https://cdn.example.com/hero.jpg',
        storagePath: 'remote/hero.jpg',
        storageAdapterId: 'acme.cdn',
        externallyHosted: true,
      }),
    ])
    expect(files).toEqual([
      { publicPath: '/uploads/hero-poster.jpg', storagePath: 'hero-poster.jpg' },
      { publicPath: '/uploads/hero-w50.webp', storagePath: 'hero-w50.webp' },
      { publicPath: '/uploads/hero.jpg', storagePath: 'hero.jpg' },
    ])
  })

  it('adds self-hosted font files that do not belong to media assets', () => {
    const siteWithFonts = {
      ...site,
      settings: {
        fonts: {
          items: [{
            id: 'inter',
            source: 'google',
            family: 'Inter',
            variants: ['400'],
            subsets: ['latin'],
            files: [{
              variant: '400',
              subset: 'latin',
              path: '/uploads/fonts/inter/inter-latin.woff2',
              format: 'woff2',
            }],
            createdAt: 1,
            updatedAt: 1,
          }],
          tokens: {},
        },
      },
    } as SiteDocument

    expect(collectSiteArtifactUploadedFiles(siteWithFonts, [])).toEqual([{
      publicPath: '/uploads/fonts/inter/inter-latin.woff2',
      storagePath: 'fonts/inter/inter-latin.woff2',
    }])
  })

  it('materializes a Railway context with only public files and the generic runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'instatic-site-artifact-'))
    tempDirs.push(root)
    const uploadsDir = join(root, 'uploads')
    const slotDir = join(uploadsDir, 'published', 'a')
    const outputDir = join(root, 'deploy')
    const runtimeCacheRoot = join(root, 'runtime-cache')
    const runtimeHash = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    await mkdir(join(slotDir, '.instatic'), { recursive: true })
    await mkdir(
      join(runtimeCacheRoot, 'deps', runtimeHash, 'node_modules', 'example-package'),
      { recursive: true },
    )
    await writeFile(join(slotDir, 'index.html'), '<h1>Exported</h1>')
    await writeFile(join(uploadsDir, 'hero.jpg'), 'image-bytes')
    await writeFile(
      join(runtimeCacheRoot, 'deps', runtimeHash, 'node_modules', 'example-package', 'index.js'),
      'export const ready = true',
    )
    const manifest = createSiteArtifactManifest({
      artifactId: 'publish-1',
      site,
      publishVersion: 1,
      pageRoutes: ['/'],
      contentRoutes: [],
      hasNotFoundRoute: false,
      htmlDocuments: ['<h1>Exported</h1>'],
      moduleJsAssets: new Map(),
      mediaAssets: [mediaAsset()],
      runtimePackageCacheHash: runtimeHash,
      publishedAt: '2026-01-01T00:00:00.000Z',
    })
    await writeFile(
      join(slotDir, '.instatic', 'site-artifact.json'),
      JSON.stringify(manifest),
    )

    await materializeSiteArtifact({
      uploadsDir,
      outputDir,
      runtimeTemplateDir: join(ROOT, 'site-runtime'),
      runtimeCacheRoot,
    })

    expect((await readdir(outputDir)).sort()).toEqual([
      'Dockerfile',
      'public',
      'railway.json',
      'runtime.ts',
    ])
    expect(await readFile(join(outputDir, 'public', 'index.html'), 'utf8')).toContain('Exported')
    expect(await readFile(join(outputDir, 'public', 'uploads', 'hero.jpg'), 'utf8')).toBe('image-bytes')
    expect(await readFile(
      join(
        outputDir,
        'public',
        '_instatic',
        'runtime',
        'cache',
        runtimeHash,
        'example-package',
        'index.js',
      ),
      'utf8',
    )).toContain('ready')
    expect(await readFile(join(outputDir, 'runtime.ts'), 'utf8')).not.toContain('@core/')
  })
})
