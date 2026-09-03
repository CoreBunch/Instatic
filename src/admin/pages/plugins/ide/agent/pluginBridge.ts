/**
 * Plugin-scope browser bridge — turns a server-issued `toolRequest` into an
 * operation against the live Plugin IDE via the registered
 * `PluginIdeBridgeHandle`.
 *
 * Both the chat panel and the workspace-scoped MCP relay call
 * `executePluginTool(name, input)`; each result is posted back through the
 * shared tool-result endpoint.
 *
 * Per-tool inputs are re-validated against the SAME TypeBox schemas the
 * server advertises (`@core/ai`) — defence in depth at the browser
 * boundary. File mutations go through the IdeCollabSession, so agent edits
 * are CRDT transactions that merge character-level with concurrent human
 * typing, ride the relay's persistence, and appear to co-editors live.
 *
 * Tool paths are RELATIVE to the plugin folder; this module joins them
 * against `plugins/<localId>/` and rejects anything that escapes it.
 *
 * Mirrors `contentBridge.ts` / the site executor — same canonical
 * `AiToolOutput` return type.
 */
import {
  aiToolError,
  aiToolOk,
  applyExactReplacements,
  hashText,
  paginateText,
  utf8ByteLength,
  PluginDeleteFileInputSchema,
  PluginListFilesInputSchema,
  PluginOpenFileInputSchema,
  PluginPatchFileInputSchema,
  PluginReadFileInputSchema,
  PluginRenameFileInputSchema,
  PluginWriteFileInputSchema,
  type AiToolOutput,
} from '@core/ai'
import { isSafePath, normalizePath } from '@core/files/pathValidation'
import { sitePluginFolder } from '@core/site-plugins'
import { getErrorMessage } from '@core/utils/errorMessage'
import { parseValue, type Static } from '@core/utils/typeboxHelpers'
import type { IdeCollabSession, IdeFileMeta } from '../ideCollab'
import {
  getPluginIdeBridgeHandle,
  type PluginIdeBridgeHandle,
} from './pluginBridgeHandle'

const DEFAULT_READ_MAX_CHARS = 12000

interface BridgeCtx {
  handle: PluginIdeBridgeHandle
  session: IdeCollabSession
  folder: string
}

function requireCtx(): BridgeCtx | AiToolOutput {
  const handle = getPluginIdeBridgeHandle()
  if (!handle) {
    return aiToolError('The Plugin IDE is not open — open /admin/plugins/develop/<id> first.')
  }
  const session = handle.session()
  if (!session || !session.synced()) {
    return aiToolError('The Plugin IDE session is still connecting — retry in a moment.')
  }
  return { handle, session, folder: sitePluginFolder(handle.localId) }
}

function isBridgeCtx(value: BridgeCtx | AiToolOutput): value is BridgeCtx {
  return !('ok' in value)
}

/** Join a model-supplied relative path onto the plugin folder, safely. */
function resolveRelativePath(ctx: BridgeCtx, relative: string): string | null {
  const normalized = normalizePath(relative)
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return null
  }
  const full = `${ctx.folder}${normalized}`
  if (!isSafePath(full) || !full.startsWith(ctx.folder)) return null
  return full
}

function relativePathOf(ctx: BridgeCtx, file: IdeFileMeta): string {
  return file.path.slice(ctx.folder.length)
}

function resolveFile(
  ctx: BridgeCtx,
  ref: { fileId?: string; path?: string },
): { ok: true; file: IdeFileMeta } | { ok: false; error: string } {
  if (!ref.fileId && !ref.path) {
    return { ok: false, error: 'Pass either fileId or path to identify the file.' }
  }
  const files = ctx.handle.files()

  let file: IdeFileMeta | undefined
  if (ref.fileId) {
    file = files.find((candidate) => candidate.id === ref.fileId)
    if (!file) return { ok: false, error: `File not found: ${ref.fileId}` }
  }
  if (ref.path) {
    const full = resolveRelativePath(ctx, ref.path)
    if (!full) return { ok: false, error: `Invalid plugin file path: ${ref.path}` }
    const pathFile = files.find((candidate) => candidate.path === full)
    if (!pathFile) return { ok: false, error: `File not found: ${ref.path}` }
    if (file && pathFile.id !== file.id) {
      return { ok: false, error: `fileId ${file.id} does not match path ${ref.path}.` }
    }
    file = pathFile
  }
  return { ok: true, file: file! }
}

/** Live text of a file, or null when the entry carries no editable text. */
function contentOf(ctx: BridgeCtx, fileId: string): string | null {
  return ctx.session.contentText(fileId)?.toString() ?? null
}

function noTextError(ctx: BridgeCtx, file: IdeFileMeta): AiToolOutput {
  return aiToolError(`${relativePathOf(ctx, file)} has no editable text content.`)
}

async function describeFile(ctx: BridgeCtx, file: IdeFileMeta) {
  const content = contentOf(ctx, file.id) ?? ''
  return {
    fileId: file.id,
    path: relativePathOf(ctx, file),
    contentChars: content.length,
    bytes: utf8ByteLength(content),
    hash: await hashText(content),
    updatedAt: file.updatedAt,
  }
}

function isManifestFile(ctx: BridgeCtx, file: IdeFileMeta): boolean {
  return file.path === `${ctx.folder}plugin.json`
}

// ---------------------------------------------------------------------------
// Per-tool runners
// ---------------------------------------------------------------------------

async function runListFiles(ctx: BridgeCtx): Promise<AiToolOutput> {
  const files = await Promise.all(ctx.handle.files().map((file) => describeFile(ctx, file)))
  return aiToolOk({ files })
}

async function runReadFile(
  ctx: BridgeCtx,
  input: Static<typeof PluginReadFileInputSchema>,
): Promise<AiToolOutput> {
  const resolved = resolveFile(ctx, input)
  if (!resolved.ok) return aiToolError(resolved.error)

  const content = contentOf(ctx, resolved.file.id)
  if (content === null) return noTextError(ctx, resolved.file)
  const page = paginateText(content, {
    part: input.part,
    maxChars: input.maxChars,
    defaultMaxChars: DEFAULT_READ_MAX_CHARS,
  })
  if (!page.ok) return aiToolError(page.error)
  return aiToolOk({
    fileId: resolved.file.id,
    path: relativePathOf(ctx, resolved.file),
    content: page.content,
    hash: await hashText(content),
    pageInfo: page.pageInfo,
  })
}

async function runWriteFile(
  ctx: BridgeCtx,
  input: Static<typeof PluginWriteFileInputSchema>,
): Promise<AiToolOutput> {
  const full = resolveRelativePath(ctx, input.path)
  if (!full) return aiToolError(`Invalid plugin file path: ${input.path}`)

  const existing = ctx.handle.files().find((file) => file.path === full)
  if (existing) {
    ctx.session.replaceFileContent(existing.id, input.content)
    return aiToolOk({ ...(await describeFile(ctx, existing)), created: false })
  }

  let fileId: string
  try {
    fileId = ctx.session.createFile(full, input.content)
  } catch (err) {
    return aiToolError(getErrorMessage(err, `Could not create ${input.path}`))
  }
  const created = ctx.handle.files().find((file) => file.id === fileId)
  if (!created) return aiToolError(`Create failed for ${input.path}`)
  return aiToolOk({ ...(await describeFile(ctx, created)), created: true })
}

async function runPatchFile(
  ctx: BridgeCtx,
  input: Static<typeof PluginPatchFileInputSchema>,
): Promise<AiToolOutput> {
  const resolved = resolveFile(ctx, input)
  if (!resolved.ok) return aiToolError(resolved.error)

  const currentContent = contentOf(ctx, resolved.file.id)
  if (currentContent === null) return noTextError(ctx, resolved.file)
  const currentHash = await hashText(currentContent)
  if (currentHash !== input.expectedHash) {
    return aiToolError(
      `Hash mismatch for ${relativePathOf(ctx, resolved.file)} — the file changed since you read it. Call plugin_read_file again before patching.`,
    )
  }

  const applied = applyExactReplacements(currentContent, input.replacements)
  if (!applied.ok) {
    const path = relativePathOf(ctx, resolved.file)
    return aiToolError(
      applied.reason === 'not-found'
        ? `Replacement text not found in ${path}.`
        : `Replacement in ${path} is ambiguous: ${applied.matches} matches. ` +
            'Use a larger oldText span or set replaceAll:true.',
    )
  }

  // The hash check awaited a digest; a remote keystroke that landed in that
  // window would be reverted by a diff computed from the pre-digest text.
  if (contentOf(ctx, resolved.file.id) !== currentContent) {
    return aiToolError(
      `${relativePathOf(ctx, resolved.file)} changed while patching. Call plugin_read_file again before patching.`,
    )
  }

  ctx.session.replaceFileContent(resolved.file.id, applied.content)
  return aiToolOk({
    ...(await describeFile(ctx, resolved.file)),
    replacements: applied.replaced,
  })
}

async function runRenameFile(
  ctx: BridgeCtx,
  input: Static<typeof PluginRenameFileInputSchema>,
): Promise<AiToolOutput> {
  const resolved = resolveFile(ctx, input)
  if (!resolved.ok) return aiToolError(resolved.error)
  if (isManifestFile(ctx, resolved.file)) {
    return aiToolError('plugin.json cannot be renamed — the build requires the manifest at the plugin root.')
  }
  const full = resolveRelativePath(ctx, input.newPath)
  if (!full) return aiToolError(`Invalid plugin file path: ${input.newPath}`)
  try {
    ctx.session.renameFile(resolved.file.id, full)
  } catch (err) {
    return aiToolError(getErrorMessage(err, `Could not rename to ${input.newPath}`))
  }
  return aiToolOk({ fileId: resolved.file.id, path: input.newPath })
}

function runDeleteFile(
  ctx: BridgeCtx,
  input: Static<typeof PluginDeleteFileInputSchema>,
): AiToolOutput {
  const resolved = resolveFile(ctx, input)
  if (!resolved.ok) return aiToolError(resolved.error)
  if (isManifestFile(ctx, resolved.file)) {
    return aiToolError('plugin.json cannot be deleted — every plugin needs its manifest.')
  }
  ctx.session.deleteFile(resolved.file.id)
  return aiToolOk({ deleted: true, fileId: resolved.file.id })
}

function runOpenFile(
  ctx: BridgeCtx,
  input: Static<typeof PluginOpenFileInputSchema>,
): AiToolOutput {
  const resolved = resolveFile(ctx, input)
  if (!resolved.ok) return aiToolError(resolved.error)
  ctx.handle.selectFile(resolved.file.id)
  return aiToolOk({ opened: relativePathOf(ctx, resolved.file) })
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set([
  'plugin_write_file',
  'plugin_patch_file',
  'plugin_rename_file',
  'plugin_delete_file',
])

export async function executePluginTool(
  toolName: string,
  input: unknown,
): Promise<AiToolOutput> {
  const ctxOrError = requireCtx()
  if (!isBridgeCtx(ctxOrError)) return ctxOrError
  const ctx = ctxOrError

  // Capability re-check at the boundary: the server never offers write
  // tools to callers without plugins.edit, but the bridge validates its own
  // side too (defence in depth — mirrors the relay's update guard).
  if (WRITE_TOOLS.has(toolName) && !ctx.handle.canEdit()) {
    return aiToolError('You do not have the plugins.edit capability.')
  }

  try {
    switch (toolName) {
      case 'plugin_list_files':
        parseValue(PluginListFilesInputSchema, input)
        return await runListFiles(ctx)
      case 'plugin_read_file':
        return await runReadFile(ctx, parseValue(PluginReadFileInputSchema, input))
      case 'plugin_write_file':
        return await runWriteFile(ctx, parseValue(PluginWriteFileInputSchema, input))
      case 'plugin_patch_file':
        return await runPatchFile(ctx, parseValue(PluginPatchFileInputSchema, input))
      case 'plugin_rename_file':
        return await runRenameFile(ctx, parseValue(PluginRenameFileInputSchema, input))
      case 'plugin_delete_file':
        return runDeleteFile(ctx, parseValue(PluginDeleteFileInputSchema, input))
      case 'plugin_open_file':
        return runOpenFile(ctx, parseValue(PluginOpenFileInputSchema, input))
      default:
        return aiToolError(`Unknown plugin tool: ${toolName}`)
    }
  } catch (err) {
    return aiToolError(getErrorMessage(err, `Tool ${toolName} failed.`))
  }
}
