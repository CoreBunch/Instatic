/**
 * Path utilities shared by the import pipeline — FileMap keys are relative,
 * slash-separated paths, so resolution here is pure string work (no Node
 * `path` module, which would break in the browser).
 */

/** Return the directory part of a path (everything before the last `/`). */
export function dirname(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash >= 0 ? filePath.slice(0, slash) : ''
}

/**
 * Join a base directory path with a relative path, resolving `.` and `..`.
 * Returns a normalized relative path with no leading `./`. A `..` that would
 * escape to a parent of the root is ignored.
 */
export function joinPaths(dir: string, relative: string): string {
  const base = dir ? dir.split('/') : []
  const parts = [...base, ...relative.split('/')]
  const resolved: string[] = []

  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (resolved.length > 0) resolved.pop()
    } else {
      resolved.push(part)
    }
  }

  return resolved.join('/')
}
