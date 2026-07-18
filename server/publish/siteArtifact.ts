import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SiteDocument } from '@core/page-tree'
import {
  SiteArtifactManifestSchema,
  type SiteArtifactManifest,
  type SiteArtifactUploadedFile,
  type SiteArtifactRequirement,
  type SiteArtifactRequirementCode,
  type SiteArtifactRoute,
} from '@core/site-artifact'
import { parseValue } from '@core/utils/typeboxHelpers'
import type { MediaAsset } from '../repositories/media'
import { nodeModulesDirForHash } from './runtime/dependencyCache'
import { getActiveSlot } from './staticArtefact'

export const SITE_ARTIFACT_MANIFEST_PATH = '/.instatic/site-artifact.json'

const REQUIREMENT_MESSAGES: Record<SiteArtifactRequirementCode, string> = {
  'dynamic-holes': 'Request-dependent page regions still require the Instatic dynamic rendering service.',
  'infinite-loops': 'Infinite-loading loops still require the Instatic loop endpoint.',
  'cms-forms': 'CMS-native forms still require the Instatic form submission service.',
  'proxied-media': 'One or more media URLs require a private storage adapter redirect.',
  'plugin-frontend-assets': 'A plugin frontend asset still loads from the builder upload directory.',
  'plugin-public-routes': 'An enabled plugin can register public server routes in the builder.',
}

interface CreateSiteArtifactManifestInput {
  artifactId: string
  site: SiteDocument
  publishVersion: number
  pageRoutes: readonly string[]
  contentRoutes: readonly string[]
  hasNotFoundRoute: boolean
  htmlDocuments: readonly string[]
  moduleJsAssets: ReadonlyMap<string, string>
  mediaAssets: ReadonlyArray<MediaAsset & { storagePath: string }>
  runtimePackageCacheHash?: string
  requirementCodes?: readonly SiteArtifactRequirementCode[]
  publishedAt?: string
}

export function createSiteArtifactManifest(
  input: CreateSiteArtifactManifestInput,
): SiteArtifactManifest {
  const routes: SiteArtifactRoute[] = []
  const seenRoutes = new Set<string>()
  const addRoutes = (paths: readonly string[], kind: SiteArtifactRoute['kind']): void => {
    for (const path of paths) {
      if (seenRoutes.has(path)) continue
      seenRoutes.add(path)
      routes.push({ path, file: artifactFileForRoute(path), kind })
    }
  }
  addRoutes(input.pageRoutes, 'page')
  addRoutes(input.contentRoutes, 'content')
  if (input.hasNotFoundRoute) addRoutes(['/404'], 'notFound')

  const requirements = detectSiteArtifactRequirements(
    input.htmlDocuments,
    input.moduleJsAssets,
    input.requirementCodes,
  )

  return {
    schemaVersion: 1,
    artifactId: input.artifactId,
    siteId: input.site.id,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
    publishVersion: input.publishVersion,
    routes,
    uploadedFiles: collectSiteArtifactUploadedFiles(input.site, input.mediaAssets),
    ...(input.runtimePackageCacheHash
      ? { runtimePackageCache: { hash: input.runtimePackageCacheHash } }
      : {}),
    deployment: {
      mode: 'static',
      portable: requirements.length === 0,
      requirements,
    },
  }
}

export function detectSiteArtifactRequirements(
  htmlDocuments: readonly string[],
  moduleJsAssets: ReadonlyMap<string, string>,
  additionalCodes: readonly SiteArtifactRequirementCode[] = [],
): SiteArtifactRequirement[] {
  const codes = new Set<SiteArtifactRequirementCode>(additionalCodes)
  for (const html of htmlDocuments) {
    if (html.includes('/_instatic/hole-runtime.js') || html.includes('<instatic-hole')) {
      codes.add('dynamic-holes')
    }
    if (html.includes('/_instatic/assets/loop-runtime.js')) codes.add('infinite-loops')
    if (html.includes('/_instatic/media/')) codes.add('proxied-media')
    if (html.includes('/uploads/plugins/')) codes.add('plugin-frontend-assets')
  }
  for (const source of moduleJsAssets.values()) {
    if (source.includes('/_instatic/form/')) codes.add('cms-forms')
    if (source.includes('/_instatic/media/')) codes.add('proxied-media')
  }
  return [...codes]
    .sort()
    .map((code) => ({ code, message: REQUIREMENT_MESSAGES[code] }))
}

export function collectSiteArtifactMediaFiles(
  assets: ReadonlyArray<MediaAsset & { storagePath: string }>,
): SiteArtifactUploadedFile[] {
  const files = new Map<string, SiteArtifactUploadedFile>()
  const add = (publicPath: string, storagePath: string): void => {
    if (!publicPath.startsWith('/uploads/') || !isSafeRelativePath(storagePath)) return
    files.set(publicPath, { publicPath, storagePath })
  }

  for (const asset of assets) {
    if (asset.storageAdapterId === '' && !asset.externallyHosted) {
      add(asset.publicPath, asset.storagePath)
    }
    for (const variant of asset.variants) {
      if (variant.storageAdapterId === '') add(variant.path, variant.storagePath)
    }
    if (asset.posterPath) add(`/uploads/${asset.posterPath}`, asset.posterPath)
  }
  return [...files.values()].sort((a, b) => a.publicPath.localeCompare(b.publicPath))
}

export function collectSiteArtifactUploadedFiles(
  site: SiteDocument,
  assets: ReadonlyArray<MediaAsset & { storagePath: string }>,
): SiteArtifactUploadedFile[] {
  const files = new Map(
    collectSiteArtifactMediaFiles(assets).map((file) => [file.publicPath, file]),
  )
  for (const font of site.settings?.fonts?.items ?? []) {
    for (const file of font.files) {
      if (file.mediaAssetId || !file.path.startsWith('/uploads/')) continue
      const storagePath = file.path.slice('/uploads/'.length)
      if (!isSafeRelativePath(storagePath)) continue
      files.set(file.path, { publicPath: file.path, storagePath })
    }
  }
  return [...files.values()].sort((a, b) => a.publicPath.localeCompare(b.publicPath))
}

export function artifactFileForRoute(urlPath: string): string {
  if (!urlPath.startsWith('/')) throw new Error(`Artifact route must start with "/": ${urlPath}`)
  const stripped = urlPath.slice(1)
  if (!isSafeRelativePath(stripped || 'index.html')) {
    throw new Error(`Unsafe artifact route: ${urlPath}`)
  }
  return stripped === '' || stripped.endsWith('/')
    ? `${stripped}index.html`
    : `${stripped}.html`
}

export async function writeSiteArtifactManifest(
  slotDir: string,
  manifest: SiteArtifactManifest,
): Promise<void> {
  const parsed = parseValue(SiteArtifactManifestSchema, manifest)
  const target = resolveWithin(slotDir, SITE_ARTIFACT_MANIFEST_PATH.slice(1))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
}

interface MaterializeSiteArtifactOptions {
  uploadsDir: string
  outputDir: string
  runtimeTemplateDir: string
  runtimeCacheRoot?: string
  allowIncomplete?: boolean
}

export async function materializeSiteArtifact(
  options: MaterializeSiteArtifactOptions,
): Promise<SiteArtifactManifest> {
  const uploadsDir = resolve(options.uploadsDir)
  const outputDir = resolve(options.outputDir)
  assertSafeOutputDirectory(outputDir, uploadsDir)

  const activeSlot = await getActiveSlot(uploadsDir)
  const sourceDir = join(uploadsDir, 'published', activeSlot)
  const manifestPath = resolveWithin(sourceDir, SITE_ARTIFACT_MANIFEST_PATH.slice(1))
  const manifest = parseValue(
    SiteArtifactManifestSchema,
    JSON.parse(await readFile(manifestPath, 'utf8')),
  )
  if (!manifest.deployment.portable && !options.allowIncomplete) {
    const blockers = manifest.deployment.requirements.map((item) => item.code).join(', ')
    throw new Error(
      `Published site is not portable yet (${blockers}). ` +
      'Replace those features or pass --allow-incomplete to export a preview deployment.',
    )
  }

  await rm(outputDir, { recursive: true, force: true })
  const publicDir = join(outputDir, 'public')
  await mkdir(publicDir, { recursive: true })
  await cp(sourceDir, publicDir, { recursive: true, dereference: true })

  if (manifest.runtimePackageCache) {
    const hash = manifest.runtimePackageCache.hash
    const source = nodeModulesDirForHash(hash, options.runtimeCacheRoot)
    const target = resolveWithin(publicDir, `_instatic/runtime/cache/${hash}`)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, dereference: true })
  }

  for (const uploadedFile of manifest.uploadedFiles) {
    const source = resolveWithin(uploadsDir, uploadedFile.storagePath)
    const target = resolveWithin(publicDir, uploadedFile.publicPath.slice(1))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }

  const runtimeTemplateDir = resolve(options.runtimeTemplateDir)
  await Promise.all([
    copyFile(join(runtimeTemplateDir, 'runtime.ts'), join(outputDir, 'runtime.ts')),
    copyFile(join(runtimeTemplateDir, 'Dockerfile'), join(outputDir, 'Dockerfile')),
    copyFile(join(runtimeTemplateDir, 'railway.json'), join(outputDir, 'railway.json')),
  ])
  return manifest
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false
  const normalized = path.replace(/\\/g, '/')
  return !normalized.split('/').some((segment) => segment === '..')
}

function resolveWithin(root: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) throw new Error(`Unsafe artifact path: ${relativePath}`)
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, relativePath)
  const rel = relative(resolvedRoot, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Artifact path escapes root: ${relativePath}`)
  return target
}

function assertSafeOutputDirectory(outputDir: string, uploadsDir: string): void {
  const root = resolve(outputDir).split(/[\\/]/).filter(Boolean)
  if (root.length < 2) throw new Error(`Refusing broad artifact output directory: ${outputDir}`)
  if (outputDir === resolve(process.cwd()) || outputDir === uploadsDir) {
    throw new Error(`Refusing to replace protected directory: ${outputDir}`)
  }
}
