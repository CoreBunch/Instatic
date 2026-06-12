/**
 * Path helpers for the site-explorer organization model. FileMap-style
 * slash-separated paths; shared by the section reconciler (siteExplorer.ts)
 * and the structural row enumeration (structuralRows.ts).
 */

/** The folder path containing `path`, or `undefined` for root-level paths. */
export function parentPathForPath(path: string): string | undefined {
  const index = path.lastIndexOf('/')
  return index === -1 ? undefined : path.slice(0, index)
}

/** Add every ancestor folder prefix of `path` (excluding the leaf) to `folders`. */
export function addFolderPrefixes(folders: Set<string>, path: string): void {
  const segments = path.split('/').filter(Boolean)
  let current = ''
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = current ? `${current}/${segments[index]}` : segments[index]
    folders.add(current)
  }
}

export function optionalParentPath(parentPath: string | undefined): { parentPath?: string } {
  return parentPath ? { parentPath } : {}
}
