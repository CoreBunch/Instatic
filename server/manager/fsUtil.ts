/**
 * Filesystem helpers shared by the Manager API: safe relative paths, a
 * recursive file walk, streaming SHA-256 with a small cache, ranged file
 * responses, and a free-space probe.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, statfs, unlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface WalkedFile {
  /** `/`-separated path relative to the walk root. */
  path: string
  sizeBytes: number
  mtimeMs: number
}

/**
 * True for a `/`-separated relative path that cannot escape its root: no
 * leading slash, no backslash, no empty / `.` / `..` segment, no NUL.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false
  if (path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Resolve a safe relative path under `root` using the platform separator. */
export function resolveRelative(root: string, path: string): string {
  return join(root, ...path.split('/'))
}

/**
 * List every regular file under `root`. Symlinks are skipped (never followed)
 * and `excludeDir`, when it sits inside the root, is not descended into.
 */
export async function walkFiles(root: string, excludeDir?: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  const excluded = excludeDir ? resolve(excludeDir) : null

  async function visit(dir: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (excluded && resolve(abs) === excluded) continue
        await visit(abs, rel)
      } else if (entry.isFile()) {
        const info = await stat(abs).catch(() => null)
        if (info) out.push({ path: rel, sizeBytes: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }

  await visit(resolve(root), '')
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

/** Remove directories under `root` that became empty; the root itself stays. */
export async function pruneEmptyDirs(root: string, excludeDir?: string): Promise<void> {
  const excluded = excludeDir ? resolve(excludeDir) : null

  async function visit(dir: string, isRoot: boolean): Promise<boolean> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let empty = true
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (excluded && resolve(abs) === excluded) {
          empty = false
          continue
        }
        if (!(await visit(abs, false))) empty = false
      } else {
        empty = false
      }
    }
    if (empty && !isRoot) {
      await rmdir(dir).catch(() => undefined)
      return true
    }
    return false
  }

  await visit(resolve(root), true)
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

interface HashEntry {
  sizeBytes: number
  mtimeMs: number
  sha256: string
}

/**
 * SHA-256 with a cache keyed by absolute path and validated by size + mtime,
 * so re-listing an unchanged uploads tree does not re-read every byte.
 *
 * The cache is persisted to a file: every push ends in a restart, and a cold
 * cache would mean re-hashing the whole tree inside one request each time.
 * `retain` drops entries for files that no longer exist, so it cannot grow
 * past the tree it describes.
 */
export class FileHashCache {
  private entries = new Map<string, HashEntry>()
  private loadedFrom: string | null = null
  private dirty = false

  /** Load the persisted cache once per file; a missing or bad file is an empty cache. */
  async load(file: string): Promise<void> {
    if (this.loadedFrom === file) return
    this.loadedFrom = file
    this.entries = new Map()
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'))
      if (parsed === null || typeof parsed !== 'object') return
      for (const [path, value] of Object.entries(parsed)) {
        if (
          value !== null && typeof value === 'object' &&
          'sizeBytes' in value && typeof value.sizeBytes === 'number' &&
          'mtimeMs' in value && typeof value.mtimeMs === 'number' &&
          'sha256' in value && typeof value.sha256 === 'string'
        ) {
          this.entries.set(path, { sizeBytes: value.sizeBytes, mtimeMs: value.mtimeMs, sha256: value.sha256 })
        }
      }
    } catch {
      // No cache yet, or an unreadable one: start empty.
    }
  }

  async hash(absPath: string, sizeBytes: number, mtimeMs: number): Promise<string> {
    const cached = this.entries.get(absPath)
    if (cached && cached.sizeBytes === sizeBytes && cached.mtimeMs === mtimeMs) return cached.sha256
    const sha256 = await sha256File(absPath)
    this.entries.set(absPath, { sizeBytes, mtimeMs, sha256 })
    this.dirty = true
    return sha256
  }

  /**
   * Record a hash that is already known, for a file expected to have this
   * size and modification time. Used when a transfer is committed: the
   * uploaded files were just verified, and moving them into place keeps
   * their modification time, so the files they become need not be read
   * again after the restart. An entry that turns out not to match the file
   * at its path (the move never happened, or the time was not kept) is
   * simply a miss: the file is read and hashed as usual.
   */
  seed(absPath: string, sizeBytes: number, mtimeMs: number, sha256: string): void {
    this.entries.set(absPath, { sizeBytes, mtimeMs, sha256 })
    this.dirty = true
  }

  /** Keep only entries under `root` that are in `present`; other roots are untouched. */
  retain(root: string, present: ReadonlySet<string>): void {
    const prefix = resolve(root) + sep
    for (const path of this.entries.keys()) {
      if (path.startsWith(prefix) && !present.has(path)) {
        this.entries.delete(path)
        this.dirty = true
      }
    }
  }

  async save(file: string): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    try {
      await mkdir(dirname(file), { recursive: true })
      // A unique temporary name: two saves may overlap (a listing and a
      // commit), and each must rename only what it wrote itself.
      const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temp, JSON.stringify(Object.fromEntries(this.entries)))
      await rename(temp, file)
    } catch {
      // The cache is an optimization; failing to persist it is not an error.
    }
  }
}

/**
 * Move a file, falling back to copy + rename when source and destination are
 * on different filesystems (`EXDEV`): the database, the uploads and the
 * manager directory may each be their own volume. The copy lands under a
 * temporary name in the destination directory and is renamed into place, so
 * a reader never sees a partial file.
 */
export async function moveFile(source: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  try {
    await rename(source, dest)
    return
  } catch (err) {
    if (!(err instanceof Error) || !('code' in err) || err.code !== 'EXDEV') throw err
  }
  const temp = join(dirname(dest), `.incoming-${randomBytes(6).toString('hex')}`)
  try {
    await copyFile(source, temp)
    // A copy gets a new modification time. Carry the original over, so the
    // file is the same file to anything that keys on it (the hash cache).
    const info = await stat(source)
    await utimes(temp, info.atime, info.mtime)
    await rename(temp, dest)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
  await unlink(source)
}

/**
 * True when any existing component of `rel` under `root` (the leaf included)
 * is a symlink. Paths through symlinks are refused on every read and write:
 * following one would let a path that looks contained leave the root.
 */
export async function passesThroughSymlink(root: string, rel: string): Promise<boolean> {
  let current = root
  for (const segment of rel.split('/')) {
    current = join(current, segment)
    const info = await lstat(current).catch(() => null)
    if (!info) return false
    if (info.isSymbolicLink()) return true
  }
  return false
}

/** Free bytes on the filesystem holding `dir`, or null when it cannot be probed. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir)
    return Number(info.bavail) * Number(info.bsize)
  } catch {
    return null
  }
}

/**
 * Serve a file with single-range support, so a manager can resume a download
 * that a proxy cut off. Returns null when the file does not exist.
 */
export async function fileRangeResponse(req: Request, absPath: string): Promise<Response | null> {
  const info = await stat(absPath).catch(() => null)
  if (!info || !info.isFile()) return null
  const size = info.size
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  const file = Bun.file(absPath)
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range') ?? '')
  if (!range) {
    return new Response(file.stream(), { status: 200, headers: { ...headers, 'content-length': String(size) } })
  }
  const start = Number(range[1])
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
  }
  return new Response(file.slice(start, end + 1).stream(), {
    status: 206,
    headers: {
      ...headers,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
    },
  })
}

/** True when `child` is `parent` itself or sits inside it. */
export function isSameOrInside(parent: string, child: string): boolean {
  const a = resolve(parent)
  const b = resolve(child)
  return a === b || b.startsWith(a + sep)
}
