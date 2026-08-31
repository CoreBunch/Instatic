import { isAbsolute, relative, sep } from 'node:path'
import * as esbuild from 'esbuild'
import type { Page, SiteDocument } from '@core/page-tree'
import {
  analyzeRuntimeScriptImports,
  collectRuntimeScripts,
  DEFAULT_SCRIPT_RUNTIME_CONFIG,
  normalizeSiteRuntimeConfig,
} from '@core/site-runtime'
import type {
  PublishedPageRuntimeAssets,
  PublishedRuntimeScriptAsset,
  RuntimeScriptEntry,
  SiteRuntimeDiagnostic,
  SiteRuntimeTarget,
} from '@core/site-runtime'
import {
  clonePackageJson,
  DEFAULT_SITE_PACKAGE_JSON,
} from '@core/site-dependencies/manifest'
import type { RuntimeDependencyCache } from './dependencyCache'
import { contentTypeForPath } from './packageServer'
import { materializeSiteScriptWorkspace } from './virtualSiteWorkspace'

export interface BuiltRuntimeAssetFile {
  path: string
  publicPath: string
  content: string
  bytes: Uint8Array
  contentType: string
}

export interface SiteRuntimeBuildResult {
  files: BuiltRuntimeAssetFile[]
  runtimeAssets: PublishedPageRuntimeAssets
  diagnostics: SiteRuntimeDiagnostic[]
}

interface BuildSiteRuntimeScriptsBaseInput {
  site: SiteDocument
  target: SiteRuntimeTarget
  assetBasePath: string
  dependencyCache?: Pick<RuntimeDependencyCache, 'nodeModulesDir'>
  dependencyNodeModulesDir?: string
  /** Override the bundle timeout (ms). Mainly for tests. */
  bundleTimeoutMs?: number
}

export type BuildSiteRuntimeScriptsInput = BuildSiteRuntimeScriptsBaseInput & (
  | {
      page: Page
      scriptSelection?: 'page'
    }
  | {
      /** Validate every enabled script, independent of its page scope. */
      scriptSelection: 'all-enabled'
      page?: never
    }
)

/**
 * Hard upper bound on the time a single esbuild invocation may run.
 * Pathological imports or very large script trees should fail fast rather
 * than tying up server capacity indefinitely.
 */
const DEFAULT_BUNDLE_TIMEOUT_MS = 30_000
const textEncoder = new TextEncoder()

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

function joinPublicPath(basePath: string, path: string): string {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`
  return `${base}${path.replace(/^\/+/, '')}`
}

function scriptFormat(entry: RuntimeScriptEntry): 'module' | 'classic' {
  return entry.config.format === 'classic' ? 'classic' : 'module'
}

function collectAllEnabledRuntimeScripts(
  site: SiteDocument,
  runtime: ReturnType<typeof normalizeSiteRuntimeConfig>,
): RuntimeScriptEntry[] {
  const scripts: RuntimeScriptEntry[] = []
  for (const file of site.files) {
    if (file.type !== 'script') continue
    const config = runtime.scripts[file.id] ?? { ...DEFAULT_SCRIPT_RUNTIME_CONFIG }
    if (config.enabled) scripts.push({ file, config })
  }
  return scripts.sort((a, b) => {
    const priority = a.config.priority - b.config.priority
    return priority || a.file.path.localeCompare(b.file.path)
  })
}

function safeOutputFileName(path: string): string {
  const base = path.split('/').pop() ?? 'script.js'
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe) return 'script.js'
  return safe.endsWith('.js') ? safe : `${safe}.js`
}

function uniqueClassicOutputPath(
  entry: RuntimeScriptEntry,
  index: number,
  usedPaths: Set<string>,
): string {
  const base = `${String(index + 1).padStart(3, '0')}-${safeOutputFileName(entry.file.path)}`
  let path = `classic/${base}`
  let suffix = 2
  while (usedPaths.has(path)) {
    path = `classic/${base.replace(/\.js$/, '')}-${suffix}.js`
    suffix += 1
  }
  usedPaths.add(path)
  return path
}

function buildClassicRuntimeFiles(
  scripts: RuntimeScriptEntry[],
  assetBasePath: string,
): { files: BuiltRuntimeAssetFile[]; assets: PublishedRuntimeScriptAsset[] } {
  const usedPaths = new Set<string>()
  const files: BuiltRuntimeAssetFile[] = []
  const assets: PublishedRuntimeScriptAsset[] = []

  for (const [index, script] of scripts.entries()) {
    const content = script.file.content ?? ''
    const path = uniqueClassicOutputPath(script, index, usedPaths)
    const publicPath = joinPublicPath(assetBasePath, path)
    files.push({
      path,
      publicPath,
      content,
      bytes: textEncoder.encode(content),
      contentType: contentTypeForPath(path),
    })
    assets.push({
      fileId: script.file.id,
      src: publicPath,
      format: 'classic',
      placement: script.config.placement,
      timing: script.config.timing,
      priority: script.config.priority,
    })
  }

  return { files, assets }
}

function emptyRuntimeBuild(diagnostics: SiteRuntimeDiagnostic[] = []): SiteRuntimeBuildResult {
  return {
    files: [],
    runtimeAssets: { scripts: [] },
    diagnostics,
  }
}

function diagnosticPathInsideWorkspace(path: string, rootDir: string): string | undefined {
  const relativePath = isAbsolute(path) ? relative(rootDir, path) : path
  const normalized = toPosixPath(relativePath).replace(/^\.\//, '')
  if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return undefined
  }
  return normalized
}

function esbuildDiagnostics(
  error: unknown,
  site: SiteDocument,
  rootDir: string,
  entryPointByFileId: Map<string, string>,
): SiteRuntimeDiagnostic[] {
  const authoredFileById = new Map(site.files.map((file) => [file.id, file]))
  const authoredFileByWorkspacePath = new Map(
    [...entryPointByFileId.entries()].flatMap(([fileId, absolutePath]) => {
      const file = authoredFileById.get(fileId)
      return file
        ? [[toPosixPath(relative(rootDir, absolutePath)), file] as const]
        : []
    }),
  )

  if (
    error &&
    typeof error === 'object' &&
    'errors' in error &&
    Array.isArray((error as { errors: unknown }).errors)
  ) {
    return (error as { errors: Array<{ text?: string; location?: { file?: string; line?: number; column?: number } }> }).errors
      .map((item) => {
        const workspacePath = item.location?.file
          ? diagnosticPathInsideWorkspace(item.location.file, rootDir)
          : undefined
        const authoredFile = workspacePath
          ? authoredFileByWorkspacePath.get(workspacePath)
          : undefined
        return {
          code: 'runtime-bundle-error',
          severity: 'error' as const,
          message: item.text ?? 'Runtime script bundle failed',
          ...(authoredFile ? { fileId: authoredFile.id, path: authoredFile.path } : {}),
          ...(!authoredFile && workspacePath ? { path: workspacePath } : {}),
          ...(item.location?.line !== undefined ? { line: item.location.line } : {}),
          ...(item.location?.column !== undefined ? { column: item.location.column } : {}),
        }
      })
  }

  return [{
    code: 'runtime-bundle-error',
    severity: 'error',
    message: error instanceof Error ? error.message : 'Runtime script bundle failed',
  }]
}

function classicScriptDiagnostics(
  error: unknown,
  script: RuntimeScriptEntry,
): SiteRuntimeDiagnostic[] {
  if (
    error &&
    typeof error === 'object' &&
    'errors' in error &&
    Array.isArray((error as { errors: unknown }).errors)
  ) {
    return (error as { errors: Array<{ text?: string; location?: { line?: number; column?: number } }> }).errors
      .map((item) => ({
        code: 'runtime-bundle-error',
        severity: 'error' as const,
        message: item.text ?? 'Runtime script syntax check failed',
        fileId: script.file.id,
        path: script.file.path,
        ...(item.location?.line !== undefined ? { line: item.location.line } : {}),
        ...(item.location?.column !== undefined ? { column: item.location.column } : {}),
      }))
  }

  return [{
    code: 'runtime-bundle-error',
    severity: 'error',
    message: error instanceof Error ? error.message : 'Runtime script syntax check failed',
    fileId: script.file.id,
    path: script.file.path,
  }]
}

async function validateClassicRuntimeScripts(
  scripts: RuntimeScriptEntry[],
): Promise<SiteRuntimeDiagnostic[]> {
  const diagnosticsByScript = await Promise.all(scripts.map(async (script) => {
    try {
      // Classic scripts are emitted byte-for-byte so they retain browser
      // globals. Parse them separately to catch syntax errors without
      // changing their published output.
      await esbuild.transform(script.file.content ?? '', {
        loader: 'js',
        logLevel: 'silent',
        target: ['es2020'],
      })
      return []
    } catch (error) {
      return classicScriptDiagnostics(error, script)
    }
  }))
  const diagnostics: SiteRuntimeDiagnostic[] = []
  for (const scriptDiagnostics of diagnosticsByScript) {
    diagnostics.push(...scriptDiagnostics)
  }
  return diagnostics
}

function selectedScriptByEntryPoint(
  selectedScripts: RuntimeScriptEntry[],
  entryPointByFileId: Map<string, string>,
  rootDir: string,
): Map<string, RuntimeScriptEntry> {
  const entries = new Map<string, RuntimeScriptEntry>()
  for (const script of selectedScripts) {
    const absolutePath = entryPointByFileId.get(script.file.id)
    if (!absolutePath) continue
    entries.set(toPosixPath(relative(rootDir, absolutePath)), script)
  }
  return entries
}

export async function buildSiteRuntimeScripts(
  input: BuildSiteRuntimeScriptsInput,
): Promise<SiteRuntimeBuildResult> {
  const runtime = normalizeSiteRuntimeConfig(input.site.runtime)
  let selectedScripts: RuntimeScriptEntry[]
  if (input.scriptSelection === 'all-enabled') {
    selectedScripts = collectAllEnabledRuntimeScripts(input.site, runtime)
  } else {
    selectedScripts = collectRuntimeScripts({
      files: input.site.files,
      runtime,
      page: input.page,
      target: input.target,
    })
  }

  if (selectedScripts.length === 0) return emptyRuntimeBuild()

  const moduleScripts = selectedScripts.filter((entry) => scriptFormat(entry) === 'module')
  const classicScripts = selectedScripts.filter((entry) => scriptFormat(entry) === 'classic')
  const classicBuild = buildClassicRuntimeFiles(classicScripts, input.assetBasePath)
  const classicDiagnostics = await validateClassicRuntimeScripts(classicScripts)

  const packageJson = clonePackageJson(input.site.packageJson ?? DEFAULT_SITE_PACKAGE_JSON)
  const importAnalysis = analyzeRuntimeScriptImports(
    moduleScripts.map((entry) => entry.file),
    packageJson,
  )
  const staticDiagnostics = [
    ...classicDiagnostics,
    ...importAnalysis.diagnostics,
  ]
  const blockingDiagnostics = importAnalysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  if (blockingDiagnostics.length > 0) return emptyRuntimeBuild(staticDiagnostics)

  if (moduleScripts.length === 0) {
    if (classicDiagnostics.length > 0) return emptyRuntimeBuild(staticDiagnostics)
    return {
      files: classicBuild.files,
      runtimeAssets: { scripts: classicBuild.assets },
      diagnostics: staticDiagnostics,
    }
  }

  const workspace = await materializeSiteScriptWorkspace(input.site)
  try {
    const entryPoints = moduleScripts
      .map((entry) => workspace.entryPointByFileId.get(entry.file.id))
      .filter((entryPoint): entryPoint is string => Boolean(entryPoint))

    if (entryPoints.length === 0) {
      if (classicDiagnostics.length > 0) return emptyRuntimeBuild(staticDiagnostics)
      return {
        files: classicBuild.files,
        runtimeAssets: { scripts: classicBuild.assets },
        diagnostics: staticDiagnostics,
      }
    }

    const outputRoot = 'out'
    const splitRuntimeChunks = input.target === 'publish'
    // For `bundleTimeoutMs <= 0` we short-circuit before esbuild starts. A
    // `setTimeout(0)` race against a microtask-scheduled promise is
    // non-deterministic, and abandoning a live esbuild promise can surface as
    // an unhandled rejection after the temp workspace is cleaned up.
    const bundleTimeoutMs = input.bundleTimeoutMs ?? DEFAULT_BUNDLE_TIMEOUT_MS
    if (bundleTimeoutMs <= 0) {
      throw new Error(`runtime bundle timed out after ${bundleTimeoutMs}ms`)
    }

    const buildPromise = esbuild.build({
      absWorkingDir: workspace.rootDir,
      assetNames: 'assets/[name]-[hash]',
      bundle: true,
      chunkNames: 'chunks/[name]-[hash]',
      entryNames: 'entries/[name]-[hash]',
      entryPoints,
      format: 'esm',
      logLevel: 'silent',
      metafile: true,
      nodePaths: [
        ...(
          input.dependencyCache?.nodeModulesDir
            ? [input.dependencyCache.nodeModulesDir]
            : []
        ),
        ...(input.dependencyNodeModulesDir ? [input.dependencyNodeModulesDir] : []),
      ],
      outdir: outputRoot,
      platform: 'browser',
      // Inline source maps for canvas preview keep runtime errors mappable
      // back to user code without serving separate .map assets. Publish
      // output stays minimal — the published surface is read-only and we
      // would otherwise emit map files that no one consumes.
      sourcemap: input.target === 'canvas' ? 'inline' : false,
      splitting: splitRuntimeChunks,
      target: ['es2020'],
      write: false,
    })
    buildPromise.catch(() => {
      // Promise.race can return the timeout first. esbuild has no public abort
      // API for one-shot builds, so drain its eventual rejection instead of
      // letting Bun report it as an unhandled test/process error.
    })

    // Race esbuild against a timeout so a pathological build cannot stall the
    // request indefinitely. esbuild has no public abort API for one-shot
    // builds; if the timeout fires first the build promise still settles
    // later but we have already abandoned its result and torn down the
    // workspace via the outer finally.
    let build: Awaited<typeof buildPromise>
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`runtime bundle timed out after ${bundleTimeoutMs}ms`)),
        bundleTimeoutMs,
      )
    })
    try {
      build = await Promise.race([buildPromise, timeoutPromise])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }

    const files = build.outputFiles.map((file) => {
      const path = toPosixPath(relative(`${workspace.rootDir}/${outputRoot}`, file.path))
      return {
        path,
        publicPath: joinPublicPath(input.assetBasePath, path),
        content: file.text,
        bytes: file.contents,
        contentType: contentTypeForPath(path),
      }
    })
    const publicPathByOutput = new Map(files.map((file) => [`${outputRoot}/${file.path}`, file.publicPath]))
    const selectedByEntryPoint = selectedScriptByEntryPoint(
      moduleScripts,
      workspace.entryPointByFileId,
      workspace.rootDir,
    )

    const moduleAssetScripts = Object.entries(build.metafile.outputs)
      .map(([
        outputPath,
        output,
      ]): PublishedRuntimeScriptAsset | null => {
        if (!output.entryPoint) return null
        const script = selectedByEntryPoint.get(output.entryPoint)
        const src = publicPathByOutput.get(outputPath)
        if (!script || !src) return null
        return {
          fileId: script.file.id,
          src,
          format: 'module' as const,
          placement: script.config.placement,
          timing: script.config.timing,
          priority: script.config.priority,
        }
      })
      .filter((script): script is PublishedRuntimeScriptAsset => script !== null)
    const scripts = [...moduleAssetScripts, ...classicBuild.assets]
      .sort((a, b) => a.priority - b.priority || a.src.localeCompare(b.src))

    if (classicDiagnostics.length > 0) return emptyRuntimeBuild(staticDiagnostics)

    return {
      files: [...files, ...classicBuild.files],
      runtimeAssets: { scripts },
      diagnostics: staticDiagnostics,
    }
  } catch (error) {
    return emptyRuntimeBuild([
      ...staticDiagnostics,
      ...esbuildDiagnostics(error, input.site, workspace.rootDir, workspace.entryPointByFileId),
    ])
  } finally {
    await workspace.cleanup()
  }
}
