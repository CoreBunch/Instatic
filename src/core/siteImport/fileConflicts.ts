/**
 * File conflicts: imported scripts and kept stylesheets whose site path is
 * already taken, and what changed since that file was imported. Part of
 * `detectConflicts`; split out so `conflicts.ts` stays one module per
 * concern.
 */

import type { SiteDocument } from '@core/page-tree'
import type { SiteRuntimeConfig } from '@core/site-runtime'
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
 * Distinct bundle paths can normalize to the same site path. Use the stored
 * source path to identify the right copy and reserve each match only once.
 */
export function detectFileConflicts(
  site: SiteDocument,
  scripts: ImportScript[],
  stylesheets: ImportStylesheet[],
): FileConflict[] {
  const existing = new Map<string, SiteFile>()
  const bySource = new Map<string, SiteFile>()
  for (const file of site.files) {
    if (file.type !== 'script' && file.type !== 'style') continue
    existing.set(`${file.type}:${file.path}`, file)
    if (file.importRecord?.sourcePath) {
      const key = `${file.type}:${file.importRecord.sourcePath}`
      // Keep both creates another copy. Prefer the original on a later import.
      if (!bySource.has(key)) bySource.set(key, file)
    }
  }
  const conflicts: FileConflict[] = []
  const items = [
    ...scripts.map((item) => ({ kind: 'script' as const, item })),
    ...stylesheets.map((item) => ({ kind: 'style' as const, item })),
  ]
  const claimed = new Set<string>()
  for (const { kind, item } of items) {
    const { path } = item
    const sitePath = importedSiteFilePath(path, kind)
    const occupant = existing.get(`${kind}:${sitePath}`)
    // Prefer the requested destination, including a manually created file. An
    // occupant from another source belongs to that source on later imports.
    const matchesDestination = occupant && !claimed.has(occupant.id)
      && (!occupant.importRecord?.sourcePath || occupant.importRecord.sourcePath === path)
    const file = matchesDestination ? occupant : bySource.get(`${kind}:${path}`)
    if (!file || claimed.has(file.id)) continue
    claimed.add(file.id)
    const state = fileConflictState(file, item, site.runtime?.scripts?.[file.id])
    conflicts.push({
      kind,
      path,
      sitePath: file.path,
      existingFileId: file.id,
      state,
      defaultResolution: { action: state === 'changed' ? 'overwrite' : 'skip' },
    })
  }
  return conflicts
}

function fileConflictState(file: SiteFile, imported: ImportScript | ImportStylesheet, runtime?: SiteRuntimeConfig['scripts'][string]): FileConflictState {
  const record = file.importRecord
  if (!record) return file.content === imported.content ? 'unchanged' : 'differs'
  if (importSourceHash(imported) === record.sourceHash) return 'unchanged'
  // Older import records hashed the script bytes and dependencies only.
  if ('format' in imported && runtime?.format === imported.format && runtime.placement === imported.placement
    && importSourceHash({ content: imported.content, dependencies: imported.dependencies }) === record.sourceHash) return 'unchanged'
  return sha256Hex(file.content ?? '') === record.contentHash ? 'changed' : 'edited'
}
