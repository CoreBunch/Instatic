/**
 * Site-file Y layout — the shell's `files` key is a Y.Map keyed by file id;
 * each entry is a Y.Map whose `content` is a Y.Text (character-level merge
 * for co-edited code files — the site editor's code panel and the Plugin
 * IDE both ride this) and whose other fields are plain LWW values. `id` is
 * the map key, never stored inside the entry.
 *
 * Projection returns the array shape the domain uses, ordered
 * deterministically by (createdAt, id) so every peer assembles an identical
 * shell from converged state.
 */
import * as Y from 'yjs'
import type { SiteFile } from '@core/files/schemas'

export function buildSiteFileEntry(file: SiteFile): Y.Map<unknown> {
  const entry = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(file)) {
    if (key === 'id' || value === undefined) continue
    if (key === 'content' && typeof value === 'string') {
      entry.set('content', new Y.Text(value))
    } else {
      entry.set(key, value)
    }
  }
  return entry
}

export function buildSiteFilesMap(files: readonly SiteFile[]): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  for (const file of files) map.set(file.id, buildSiteFileEntry(file))
  return map
}

function projectSiteFileEntry(id: string, entry: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id }
  for (const [key, value] of entry.entries()) {
    out[key] = value instanceof Y.Text ? value.toString() : value
  }
  return out
}

/**
 * Project the shell's `files` value back to the domain array. Handles both
 * layouts: the granular Y.Map (current) and a plain LWW array (docs seeded
 * before the per-file layout existed — upgraded on the next write).
 */
export function projectSiteFilesValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const files: Record<string, unknown>[] = []
    for (const [id, entry] of value.entries()) {
      if (entry instanceof Y.Map) files.push(projectSiteFileEntry(id, entry))
    }
    files.sort((a, b) => {
      const createdA = typeof a['createdAt'] === 'number' ? (a['createdAt'] as number) : 0
      const createdB = typeof b['createdAt'] === 'number' ? (b['createdAt'] as number) : 0
      if (createdA !== createdB) return createdA - createdB
      return String(a['id']).localeCompare(String(b['id']))
    })
    return files
  }
  return value
}

/** The live Y.Text of a file's content, or null (missing file / legacy layout / asset). */
export function siteFileContentText(shell: Y.Map<unknown>, fileId: string): Y.Text | null {
  const filesMap = shell.get('files')
  if (!(filesMap instanceof Y.Map)) return null
  const entry = filesMap.get(fileId)
  if (!(entry instanceof Y.Map)) return null
  const content = entry.get('content')
  return content instanceof Y.Text ? content : null
}
