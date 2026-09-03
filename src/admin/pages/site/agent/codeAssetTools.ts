import {
  aiToolError,
  aiToolOk,
  applyExactReplacements,
  hashText,
  paginateText,
  utf8ByteLength,
  type AiToolOutput,
  type InspectCodeRuntimeInput,
  type ListCodeAssetsInput,
  type PatchCodeAssetInput,
  type ReadCodeAssetInput,
  type WriteCodeAssetInput,
} from '@core/ai'
import type { SiteFile } from '@core/files/schemas'
import { isSafePath, normalizePath } from '@core/files/pathValidation'
import type { Page } from '@core/page-tree'
import {
  DEFAULT_SCRIPT_RUNTIME_CONFIG,
  DEFAULT_STYLE_RUNTIME_CONFIG,
  assetScopeAppliesToPage,
  normalizeScriptRuntimeConfig,
  normalizeSiteRuntimeConfig,
  normalizeStyleRuntimeConfig,
} from '@core/site-runtime'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import type { EditorStore } from '@site/store/types'
import { activeRenderPage } from './documentTools'
import { getAgentStoreApi } from './storeRef'

type CodeAssetType = Extract<SiteFile['type'], 'script' | 'style'>
type CodeAssetFile = SiteFile & { type: CodeAssetType }
type CodeAssetLookup = {
  fileId?: string
  path?: string
  type?: CodeAssetType
}

// Live access to the editor store. Routed through `./storeRef` so this module
// has no static import edge back into `editor-store/store.ts`.
const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

function isCodeAssetFile(file: SiteFile): file is CodeAssetFile {
  return file.type === 'script' || file.type === 'style'
}

function contentForCodeAsset(file: CodeAssetFile): string {
  return file.content ?? ''
}

function normalizeCodeAssetPath(path: string): string | null {
  const normalized = normalizePath(path)
  return isSafePath(normalized) ? normalized : null
}

function codeAssetRuntime(store: EditorStore, file: CodeAssetFile) {
  const runtime = normalizeSiteRuntimeConfig(store.siteRuntime)
  return file.type === 'script'
    ? (runtime.scripts[file.id] ?? { ...DEFAULT_SCRIPT_RUNTIME_CONFIG })
    : (runtime.styles[file.id] ?? { ...DEFAULT_STYLE_RUNTIME_CONFIG })
}

async function describeCodeAsset(store: EditorStore, file: CodeAssetFile) {
  const content = contentForCodeAsset(file)
  return {
    fileId: file.id,
    path: file.path,
    type: file.type,
    contentChars: content.length,
    bytes: utf8ByteLength(content),
    hash: await hashText(content),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    generated: file.generated === true,
    ejected: file.ejected === true,
    runtime: codeAssetRuntime(store, file),
  }
}

function resolveCodeAsset(
  store: EditorStore,
  lookup: CodeAssetLookup,
): { ok: true; file: CodeAssetFile } | { ok: false; error: string } {
  const site = store.site
  if (!site) return { ok: false, error: 'No active site.' }
  if (!lookup.fileId && !lookup.path) {
    return { ok: false, error: 'Pass either fileId or path to identify the code asset.' }
  }

  let file: SiteFile | undefined
  if (lookup.fileId) {
    file = site.files.find((candidate) => candidate.id === lookup.fileId)
    if (!file) return { ok: false, error: `Code asset not found: ${lookup.fileId}` }
  }

  if (lookup.path) {
    const normalized = normalizeCodeAssetPath(lookup.path)
    if (!normalized) return { ok: false, error: `Invalid code asset path: ${lookup.path}` }
    const pathFile = site.files.find((candidate) => candidate.path === normalized)
    if (!pathFile) return { ok: false, error: `Code asset not found: ${normalized}` }
    if (file && pathFile.id !== file.id) {
      return {
        ok: false,
        error: `fileId ${file.id} does not match path ${normalized}.`,
      }
    }
    file = pathFile
  }

  if (!file || !isCodeAssetFile(file)) {
    return { ok: false, error: 'The referenced file is not a script or stylesheet asset.' }
  }
  if (lookup.type && file.type !== lookup.type) {
    return { ok: false, error: `Code asset ${file.path} is ${file.type}, not ${lookup.type}.` }
  }
  return { ok: true, file }
}

function setRuntimeForCodeAsset(
  store: EditorStore,
  file: CodeAssetFile,
  runtimePatch: Record<string, unknown> | undefined,
): void {
  if (file.type === 'script') {
    const current = store.siteRuntime.scripts[file.id] ?? { ...DEFAULT_SCRIPT_RUNTIME_CONFIG }
    const next = normalizeScriptRuntimeConfig(runtimePatch ? { ...current, ...runtimePatch } : current)
    store.setScriptRuntimeConfig(file.id, next)
    return
  }

  const current = store.siteRuntime.styles[file.id] ?? { ...DEFAULT_STYLE_RUNTIME_CONFIG }
  const next = normalizeStyleRuntimeConfig(runtimePatch ? { ...current, ...runtimePatch } : current)
  store.setStyleRuntimeConfig(file.id, next)
}

function normalizeRequestedRuntimeDependencies(
  input: WriteCodeAssetInput,
): { ok: true; dependencies: Record<string, string> } | { ok: false; error: string } {
  const entries = Object.entries(input.dependencies ?? {})
  if (entries.length === 0) return { ok: true, dependencies: {} }
  if (input.type !== 'script') {
    return { ok: false, error: 'Runtime dependencies can only be declared for script code assets.' }
  }

  const dependencies: Record<string, string> = {}
  for (const [rawName, rawVersion] of entries) {
    const name = rawName.trim()
    if (!isSafePackageName(name)) {
      return { ok: false, error: `Invalid npm package name: ${rawName}` }
    }
    dependencies[name] = rawVersion.trim() || '*'
  }
  return { ok: true, dependencies }
}

function runtimeInspectionPage(
  store: EditorStore,
  input: InspectCodeRuntimeInput,
): { ok: true; page: Page } | { ok: false; error: string } {
  const site = store.site
  if (!site) return { ok: false, error: 'No active site.' }

  if (!input.document) {
    const page = activeRenderPage(store)
    return page ? { ok: true, page } : { ok: false, error: 'No active document.' }
  }

  if (input.document.type === 'visualComponent') {
    return {
      ok: false,
      error: 'Runtime scripts and stylesheets target pages/templates, not visual component documents.',
    }
  }

  const page = site.pages.find((candidate) => candidate.id === input.document?.id)
  if (!page) {
    return { ok: false, error: `Page not found: ${input.document.id}` }
  }
  if (input.document.type === 'template' && !page.template) {
    return { ok: false, error: `Template not found: ${input.document.id}` }
  }
  return { ok: true, page }
}

export async function runListCodeAssets(input: ListCodeAssetsInput): Promise<AiToolOutput> {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')

  const files = site.files
    .filter(isCodeAssetFile)
    .filter((file) => !input.type || file.type === input.type)
    .sort((a, b) => a.path.localeCompare(b.path))

  const assets = []
  for (const file of files) {
    assets.push(await describeCodeAsset(store, file))
  }
  return aiToolOk({ assets })
}

export async function runReadCodeAsset(input: ReadCodeAssetInput): Promise<AiToolOutput> {
  const store = getStoreState()
  const resolved = resolveCodeAsset(store, input)
  if (!resolved.ok) return aiToolError(resolved.error)

  const content = contentForCodeAsset(resolved.file)
  const page = paginateText(content, {
    part: input.part,
    maxChars: input.maxChars,
    defaultMaxChars: 12000,
  })
  if (!page.ok) return aiToolError(`Code asset ${page.error}`)
  return aiToolOk({
    fileId: resolved.file.id,
    path: resolved.file.path,
    type: resolved.file.type,
    content: page.content,
    hash: await hashText(content),
    runtime: codeAssetRuntime(store, resolved.file),
    pageInfo: page.pageInfo,
  })
}

export async function runWriteCodeAsset(input: WriteCodeAssetInput): Promise<AiToolOutput> {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')

  const path = normalizeCodeAssetPath(input.path)
  if (!path) return aiToolError(`Invalid code asset path: ${input.path}`)
  const requestedDependencies = normalizeRequestedRuntimeDependencies(input)
  if (!requestedDependencies.ok) return aiToolError(requestedDependencies.error)

  const existing = site.files.find((file) => file.path === path)
  let fileId: string
  let action: 'created' | 'updated'
  if (existing) {
    if (!isCodeAssetFile(existing)) {
      return aiToolError(`File at ${path} is ${existing.type}, not a script or stylesheet asset.`)
    }
    if (existing.type !== input.type) {
      return aiToolError(`File at ${path} is ${existing.type}; cannot write it as ${input.type}.`)
    }
    store.updateFileContent(existing.id, input.content)
    fileId = existing.id
    action = 'updated'
  } else {
    fileId = store.createFile(path, input.type, input.content)
    action = 'created'
  }

  const afterContentStore = getStoreState()
  const file = afterContentStore.site?.files.find((candidate) => candidate.id === fileId)
  if (!file || !isCodeAssetFile(file)) {
    return aiToolError(`Code asset write failed for ${path}.`)
  }
  setRuntimeForCodeAsset(afterContentStore, file, input.runtime)

  for (const [name, version] of Object.entries(requestedDependencies.dependencies)) {
    getStoreState().setDependency(name, version, false)
  }

  const afterRuntimeStore = getStoreState()
  const finalFile = afterRuntimeStore.site?.files.find((candidate) => candidate.id === fileId)
  if (!finalFile || !isCodeAssetFile(finalFile)) {
    return aiToolError(`Code asset write failed for ${path}.`)
  }
  return aiToolOk({
    ...(await describeCodeAsset(afterRuntimeStore, finalFile)),
    action,
    dependencies: requestedDependencies.dependencies,
  })
}

export async function runPatchCodeAsset(input: PatchCodeAssetInput): Promise<AiToolOutput> {
  const store = getStoreState()
  const resolved = resolveCodeAsset(store, input)
  if (!resolved.ok) return aiToolError(resolved.error)

  const currentContent = contentForCodeAsset(resolved.file)
  const currentHash = await hashText(currentContent)
  if (currentHash !== input.expectedHash) {
    return aiToolError(
      `Code asset hash mismatch for ${resolved.file.path}; read_code_asset again before patching.`,
    )
  }

  const applied = applyExactReplacements(currentContent, input.replacements)
  if (!applied.ok) {
    return aiToolError(
      applied.reason === 'not-found'
        ? `Replacement text not found in ${resolved.file.path}.`
        : `Replacement for ${resolved.file.path} is ambiguous: ${applied.matches} matches. ` +
            'Use a larger oldText span or set replaceAll:true.',
    )
  }
  const replacementCount = applied.replaced

  store.updateFileContent(resolved.file.id, applied.content)
  const afterStore = getStoreState()
  const file = afterStore.site?.files.find((candidate) => candidate.id === resolved.file.id)
  if (!file || !isCodeAssetFile(file)) {
    return aiToolError(`Code asset patch failed for ${resolved.file.path}.`)
  }
  return aiToolOk({
    ...(await describeCodeAsset(afterStore, file)),
    replacements: replacementCount,
  })
}

export function runInspectCodeRuntime(input: InspectCodeRuntimeInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')

  const pageResult = runtimeInspectionPage(store, input)
  if (!pageResult.ok) return aiToolError(pageResult.error)

  const runtime = normalizeSiteRuntimeConfig(store.siteRuntime)
  const scripts = site.files
    .filter((file): file is CodeAssetFile => file.type === 'script')
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => {
      const config = runtime.scripts[file.id] ?? { ...DEFAULT_SCRIPT_RUNTIME_CONFIG }
      const applies = assetScopeAppliesToPage(config.scope, pageResult.page)
      return {
        fileId: file.id,
        path: file.path,
        type: file.type,
        enabled: config.enabled,
        applies,
        willRunInCanvas: config.enabled && config.runInCanvas && applies,
        runInCanvas: config.runInCanvas,
        format: config.format,
        placement: config.placement,
        timing: config.timing,
        priority: config.priority,
        scope: config.scope,
        contentChars: contentForCodeAsset(file).length,
      }
    })

  const styles = site.files
    .filter((file): file is CodeAssetFile => file.type === 'style')
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => {
      const config = runtime.styles[file.id] ?? { ...DEFAULT_STYLE_RUNTIME_CONFIG }
      const applies = assetScopeAppliesToPage(config.scope, pageResult.page)
      return {
        fileId: file.id,
        path: file.path,
        type: file.type,
        enabled: config.enabled,
        applies,
        willPublish: config.enabled && applies,
        priority: config.priority,
        scope: config.scope,
        contentChars: contentForCodeAsset(file).length,
      }
    })

  return aiToolOk({
    pageId: pageResult.page.id,
    document: {
      type: pageResult.page.template ? 'template' : 'page',
      id: pageResult.page.id,
    },
    scripts,
    styles,
  })
}
