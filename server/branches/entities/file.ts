/**
 * A site file as a branch entity: the file minus its id (the logical id) and
 * timestamps (never merged). Files live inside the shell row, so a fork or a
 * delete of the shell carries them; only collect, describe, and write are
 * theirs.
 */
import { normalizePath } from '@core/files/pathValidation'
import { SiteFileSchema, type SiteFile } from '@core/files/schemas'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { getDraftSite, saveDraftSite } from '../../repositories/site'
import { parseContent } from '../contentHash'
import { MergeApplyError, type BranchEntityAdapter, type BranchEntityOf } from './adapter'
import { validateMergedShell } from './shell'

const FileContentSchema = Type.Omit(SiteFileSchema, ['id', 'createdAt', 'updatedAt'])
export type FileContent = Static<typeof FileContentSchema>
export type FileEntity = BranchEntityOf<'file', FileContent>

function fileContent(file: SiteFile): FileContent {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = file
  return rest
}

/** A file whose path another file (a different id) already uses on the receiving side. */
const PATH_MARKER = '(path)'

export const fileAdapter: BranchEntityAdapter<'file', FileContent> = {
  kind: 'file',
  order: () => 1,

  async collect(source): Promise<FileEntity[]> {
    const shell = await source.shell()
    if (!shell) return []
    return shell.files.map((file) => ({
      kind: 'file',
      logicalId: file.id,
      label: file.path,
      tableId: null,
      tableName: null,
      content: fileContent(file),
    }))
  },

  parse: (value) => parseContent(FileContentSchema, value, 'file'),

  describe(before, after) {
    const type = after?.type ?? before?.type ?? 'script'
    const binary = type === 'asset'
    return {
      kind: 'file',
      path: after?.path ?? before?.path ?? '',
      pathBefore: before && after && before.path !== after.path ? before.path : null,
      fileType: type,
      before: binary ? null : (before?.content ?? null),
      after: binary ? null : (after?.content ?? null),
      binary,
    }
  },

  // The shell keeps one file per normalized path (first wins), so a merged
  // file that lands on a path a different file already holds would vanish
  // silently. Report it on the plan instead; applying it is refused.
  collision(result, logicalId, into) {
    const incoming = typeof result === 'object' && result !== null && 'path' in result ? result.path : undefined
    if (typeof incoming !== 'string') return null
    const path = normalizePath(incoming)
    for (const entity of into.values()) {
      if (entity.kind !== 'file' || entity.logicalId === logicalId) continue
      const other = entity.content
      const otherPath = typeof other === 'object' && other !== null && 'path' in other ? other.path : undefined
      if (typeof otherPath === 'string' && normalizePath(otherPath) === path) return PATH_MARKER
    }
    return null
  },

  async write(tx, scope, target, content, ctx) {
    const current = await getDraftSite(tx, scope)
    if (!current) return
    const now = Date.now()
    const others = current.files.filter((file) => file.id !== target.logicalId)
    let files: SiteFile[]
    if (content === null) {
      if (others.length === current.files.length) return
      files = others
    } else {
      const existing = current.files.find((file) => file.id === target.logicalId)
      // The merged content is the whole file: a key the other side dropped
      // (blob, ejected, ...) must not survive from the previous version.
      files = [...others, { id: target.logicalId, createdAt: existing?.createdAt ?? now, ...content, updatedAt: now }]
    }
    const shell = validateMergedShell(target.key, { ...current, files, updatedAt: now })
    if (shell.files.length < files.length) {
      throw new MergeApplyError(
        target.key,
        `Another file on ${scope.branchId} already uses the path "${target.label}"; rename one of them first`,
      )
    }
    await saveDraftSite(tx, scope, shell, ctx.actorUserId, { collabInternal: true })
    ctx.notices.shell = true
  },

  // Files ride in the shell row: the site adapter's copy and remove carry them.
  async copy() {},
  async remove() {},
}
