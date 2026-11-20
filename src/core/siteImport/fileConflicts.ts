/**
 * File conflicts: imported scripts and kept stylesheets whose site path is
 * already taken, and what changed since that file was imported. Part of
 * `detectConflicts`; split out so `conflicts.ts` stays one module per
 * concern.
 */

import type { SiteDocument } from '@core/page-tree'
import type { SiteFile } from '@core/files/schemas'
import { sha256Hex } from '@core/utils/sha256'
import type { ImportScript, ImportStylesheet } from './types'
import type { FileConflict, FileConflictState } from './conflictTypes'
import { importSourceHash, importedSiteFilePath } from './siteFilePaths'

/**
 * Scripts and kept stylesheets whose site file path is already taken by a
 * file of the same kind, so a second import of the same bundle does not add
 * `app-2.js` next to `app.js`. The file's `importRecord` says what changed
 * since the last import (`FileConflict.state`); only a file the bundle changed
 * and nobody edited defaults to Replace, so an edit made in Instatic is never
 * discarded by default.
 * Paths taken by a file of the other kind are left to the commit's unique-path
 * rule, as are collisions inside one import.
 */
export function detectFileConflicts(
  site: SiteDocument,
  scripts: ImportScript[],
  stylesheets: ImportStylesheet[],
): FileConflict[] {
  const existing = new Map<string, SiteFile>()
  for (const file of site.files) {
    if (file.type === 'script' || file.type === 'style') existing.set(`${file.type}:${file.path}`, file)
  }
  const conflicts: FileConflict[] = []
  const items = [
    ...scripts.map((item) => ({ kind: 'script' as const, item })),
    ...stylesheets.map((item) => ({ kind: 'style' as const, item })),
  ]
  for (const { kind, item } of items) {
    const { path } = item
    const sitePath = importedSiteFilePath(path, kind)
    const file = existing.get(`${kind}:${sitePath}`)
    if (!file) continue
    const state = fileConflictState(file, item)
    conflicts.push({
      kind,
      path,
      sitePath,
      existingFileId: file.id,
      state,
      defaultResolution: { action: state === 'changed' ? 'overwrite' : 'skip' },
    })
  }
  return conflicts
}

function fileConflictState(file: SiteFile, imported: ImportScript | ImportStylesheet): FileConflictState {
  const record = file.importRecord
  if (!record) return file.content === imported.content ? 'unchanged' : 'differs'
  if (importSourceHash(imported) === record.sourceHash) return 'unchanged'
  return sha256Hex(file.content ?? '') === record.contentHash ? 'changed' : 'edited'
}
