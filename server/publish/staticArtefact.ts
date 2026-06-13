/**
 * Slot-aware static-artefact IO helpers for Layer A of the publishing
 * architecture.
 *
 * Layout on disk:
 *
 *   <uploadsDir>/published/
 *     current  -> a | b   (symlink; visitor router reads through this)
 *     a/                  (active or inactive slot)
 *       index.html        (for URL /)
 *       about.html        (for URL /about)
 *       posts/hello.html  (for URL /posts/hello)
 *     b/                  (the other slot — mirror structure)
 *
 * The two-slot symlink swap guarantees that `current` always points to a
 * COMPLETE, valid slot. Visitors see either the old generation or the new
 * generation — never a partial state, never a missing file.
 *
 * Full publish protocol (e.g. `publishDraftSite`):
 *   1. `prepareInactiveSlot`  — wipe the inactive slot directory, recreate empty
 *   2. `writeArtefact` × N   — write each page's HTML into the inactive slot
 *   3. `swapSlot`             — atomic symlink rename; `current` now points to the new slot
 *
 * Incremental publish protocol (e.g. `publishDataRow`):
 *   - `updateArtefactInPlace` — tmp + rename into the ACTIVE slot
 *   - `removeArtefactInPlace` — unlink from the ACTIVE slot (slug change / deletion)
 *
 * Path safety: every on-disk path derived from a URL is validated by the
 * private `resolveArtefactPath` helper, which matches the style of
 * `assertPathWithin` in `server/util/pathWithin.ts`.
 */

import { dirname, isAbsolute, join, relative } from 'node:path'
import {
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Slot = 'a' | 'b'

/**
 * Artefact URL path the site's `notFound` template bakes to. Maps to
 * `404.html` in the slot — deliberately the static-hosting convention
 * (Netlify / GitHub Pages serve `404.html` for unmatched routes), so a
 * published slot keeps working as a self-contained static export. The
 * dispatcher's fall-through 404 handler reads this artefact and serves it
 * with status 404.
 */
export const NOT_FOUND_ARTEFACT_URL_PATH = '/404'

// ---------------------------------------------------------------------------
// Private path helpers
// ---------------------------------------------------------------------------

function getPublishedDir(uploadsDir: string): string {
  return join(uploadsDir, 'published')
}

function getSlotDir(uploadsDir: string, slot: Slot): string {
  return join(getPublishedDir(uploadsDir), slot)
}

function getCurrentSymlinkPath(uploadsDir: string): string {
  return join(getPublishedDir(uploadsDir), 'current')
}

/**
 * URL path → relative disk path inside a slot directory.
 *
 * Mapping rules (per spec):
 *   - empty path or trailing slash → `index.html` (or `<dir>/index.html`)
 *   - all other paths              → `<path>.html`
 *
 * Examples:
 *   /          → index.html
 *   /foo/      → foo/index.html
 *   /foo/bar   → foo/bar.html
 */
function urlToDiskRelPath(urlPath: string): string {
  // Remove leading slash for relative path construction
  const stripped = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath
  if (stripped === '' || stripped.endsWith('/')) {
    return stripped + 'index.html'
  }
  return stripped + '.html'
}

/**
 * Decode + validate a URL path, returning the safe (leading-slash-stripped)
 * relative path. Rejects:
 *   - `..` segments after URL-decoding (catches `%2e%2e` and similar)
 *   - Paths that resolve to an absolute path after stripping the leading `/`
 *
 * Throws on any violation. The raw relative path is what asset files
 * (CSS/JS bundles) map to; HTML artefacts run it through `urlToDiskRelPath`
 * for the `.html` / `index.html` mapping.
 */
function safeRelPath(urlPath: string): string {
  // Decode URL-encoded characters so %2e%2e is treated the same as ..
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    throw new Error(`Artefact URL path "${urlPath}" is not valid URL-encoded text`)
  }

  // Reject any segment that is '..' (post-decode)
  const segments = decoded.split('/')
  if (segments.some((s) => s === '..')) {
    throw new Error(`Artefact URL path "${urlPath}" contains '..' path segments`)
  }

  // Reject embedded absolute paths after stripping the leading slash
  const stripped = decoded.startsWith('/') ? decoded.slice(1) : decoded
  if (isAbsolute(stripped)) {
    throw new Error(`Artefact URL path "${urlPath}" contains an embedded absolute path`)
  }

  return stripped
}

/**
 * Validate a URL path and return its relative disk path for an HTML artefact.
 *
 * Called by `resolveArtefactPath` (for write/remove paths) and directly by
 * `readArtefact` (for read paths).
 */
function computeDiskRelPath(urlPath: string): string {
  return urlToDiskRelPath(`/${safeRelPath(urlPath)}`)
}

/**
 * Resolve a URL path to an absolute on-disk path within `slotDir`.
 *
 * Applies `computeDiskRelPath` for URL validation, joins with `slotDir`,
 * then performs a final containment check — defence-in-depth, matching the
 * style of `assertPathWithin` in `server/util/pathWithin.ts`.
 *
 * Throws on any escape attempt.
 */
function resolveArtefactPath(slotDir: string, urlPath: string): string {
  const diskRelPath = computeDiskRelPath(urlPath)
  const resolved = join(slotDir, diskRelPath)
  const rel = relative(slotDir, resolved)

  // Defence-in-depth containment check
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Artefact URL path "${urlPath}" escapes the publish root`)
  }

  return resolved
}

/** Type guard for Node.js system errors with an `errno` code. */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the currently-active slot (`'a'` or `'b'`) by reading the `current`
 * symlink target.
 *
 * Returns `'a'` when the symlink does not exist (first-ever publish; the
 * inactive slot defaults to `'b'` in that case so the first
 * `prepareInactiveSlot` call writes into `b/` and swaps to it).
 */
export async function getActiveSlot(uploadsDir: string): Promise<Slot> {
  try {
    const target = (await readlink(getCurrentSymlinkPath(uploadsDir))).trim()
    if (target === 'a' || target === 'b') return target
  } catch {
    // Symlink doesn't exist — first ever publish
  }
  return 'a'
}

/**
 * Return the inactive slot — whichever of `'a'` and `'b'` the `current`
 * symlink does NOT point to. Defaults to `'b'` on first run (no symlink).
 */
export async function getInactiveSlot(uploadsDir: string): Promise<Slot> {
  const active = await getActiveSlot(uploadsDir)
  return active === 'a' ? 'b' : 'a'
}

/**
 * Wipe and recreate the inactive slot directory — step 1 of the full publish
 * protocol.
 *
 * Safe because:
 *   - The `current` symlink still points to the ACTIVE slot during this step.
 *   - No visitor request ever reads through the inactive slot.
 *   - In-flight readers that opened files in the old inactive slot (impossible
 *     in a correctly functioning publish cycle) would still hold valid fds.
 *
 * Returns the slot name and its absolute path.
 */
export async function prepareInactiveSlot(
  uploadsDir: string,
): Promise<{ slot: Slot; slotDir: string }> {
  const slot = await getInactiveSlot(uploadsDir)
  const dir = getSlotDir(uploadsDir, slot)

  // Ensure the parent published/ directory exists before touching the slot
  await mkdir(getPublishedDir(uploadsDir), { recursive: true })

  // Wipe any stale files from the previous generation (safe: inactive slot)
  await rm(dir, { recursive: true, force: true })

  // Recreate as a clean empty directory
  await mkdir(dir, { recursive: true })

  return { slot, slotDir: dir }
}

/**
 * Atomic per-file write into a slot directory — step 2 of the full publish
 * protocol (repeated per page).
 *
 * Writes to `<final>.tmp`, then `rename(2)`s into place so no reader ever
 * sees a partial write. Creates the necessary subdirectory tree as needed.
 *
 * @param slotDir  Absolute path to the target slot directory.
 * @param urlPath  The public route URL path (e.g. `/about` or `/posts/foo`).
 * @param html     The HTML string to write.
 */
export async function writeArtefact(
  slotDir: string,
  urlPath: string,
  html: string,
): Promise<void> {
  const finalPath = resolveArtefactPath(slotDir, urlPath)
  const tmpPath = `${finalPath}.tmp`

  await mkdir(dirname(finalPath), { recursive: true })
  await writeFile(tmpPath, html, 'utf-8')
  await rename(tmpPath, finalPath)
}

/**
 * Atomic symlink swap — step 3 (the final step) of the full publish protocol.
 *
 * Writes a new `current.tmp` symlink pointing to `targetSlot`, then
 * `rename(2)`s it over `current`. `rename(2)` on a symlink is a single inode
 * swap and is atomic on all POSIX filesystems — there is no window where
 * `current` is missing or points to an incomplete slot.
 *
 * Any leftover `current.tmp` from a previously-crashed publish is silently
 * removed before creating a new one.
 */
export async function swapSlot(uploadsDir: string, targetSlot: Slot): Promise<void> {
  const publishDir = getPublishedDir(uploadsDir)
  const currentPath = getCurrentSymlinkPath(uploadsDir)
  const tmpPath = join(publishDir, 'current.tmp')

  // Ensure the published/ directory exists (may be first ever publish)
  await mkdir(publishDir, { recursive: true })

  // Remove any leftover tmp symlink from a previous crashed publish
  await rm(tmpPath, { force: true })

  // Create a new symlink at current.tmp pointing to the target slot name.
  // symlink(target, path) creates a link at `path` that points to `target`.
  await symlink(targetSlot, tmpPath)

  // Atomically replace `current` with the new symlink
  await rename(tmpPath, currentPath)
}

/**
 * Read a static artefact from the currently-active slot.
 *
 * Opens the file through the `current` symlink path — for example
 * `<uploadsDir>/published/current/about.html` — and lets the OS follow the
 * symlink to the active slot directory atomically inside a single `open(2)`
 * syscall.  This is safer than a separate `readlink` + `readFile` pair:
 * the kernel resolves the symlink component and opens the target file in one
 * operation, so no user-space window exists between them.
 *
 * **Residual races and retry:** The Bun IO thread pool runs `readFile` and
 * the writer's rename/wipe operations as parallel OS threads, so two classes
 * of transient errors can occur:
 *
 *   - `ENOENT` / `ENOTDIR`: the writer's `rm -rf <slot>` completes between the
 *     kernel's symlink resolution (`current` → X) and its `open(X/<file>)`.
 *     After the wipe the atomic rename has already advanced `current` → Y, so
 *     the next attempt re-opens through the fully-written new slot.
 *
 *   - `EINVAL` (macOS/APFS only): macOS returns `EINVAL` instead of `ENOENT`
 *     when `open(2)` traverses `current` at the exact moment
 *     `rename(current.tmp, current)` is executing — the APFS directory entry
 *     is transiently in an inconsistent state.  One retry after a
 *     `setImmediate` drain (which lets the rename's completion callback fire)
 *     always sees the completed, valid symlink.
 *
 * Both error classes are transient: the first retry always resolves to the
 * stable new slot.  Up to 5 attempts are made with one `setImmediate` drain
 * between each so that the writer's pending IO callbacks fire first.
 *
 * Returns `null` if:
 *   - The `current` symlink does not exist (no artefacts published yet).
 *   - The file does not exist in the active slot (route not published to disk).
 *   - The URL path escapes the published root (path safety).
 *   - Any other IO error occurs (treated as a miss, never thrown).
 *
 * Cheap enough to call on every no-query-string visitor request (Layer A fast
 * path: 1 syscall on cache hit, no DB).
 */
export async function readArtefact(uploadsDir: string, urlPath: string): Promise<string | null> {
  // Validate the URL and compute the relative disk path
  let diskRelPath: string
  try {
    diskRelPath = computeDiskRelPath(urlPath)
  } catch {
    // Unsafe path — return null rather than throw (callers expect null on miss)
    return null
  }

  // Open through `current/<path>` so the OS follows the symlink atomically
  // inside open(2).  The same `filePath` value is used on every attempt —
  // each call to readFile re-resolves the `current` symlink at the OS level,
  // so after a swap the next attempt automatically reads from the new slot.
  const filePath = join(getPublishedDir(uploadsDir), 'current', diskRelPath)

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await readFile(filePath, 'utf-8')
    } catch (err) {
      const code = isNodeError(err) ? err.code : null
      // Retriable errors from the atomic symlink protocol:
      //   ENOENT   — slot wipe race: the writer wiped the old slot between the
      //              kernel's symlink resolution and the actual file open.
      //   ENOTDIR  — same wipe race at the directory level.
      //   EINVAL   — macOS APFS returns EINVAL (not ENOENT) when open(2) tries to
      //              follow `current` at the exact moment rename(current.tmp →
      //              current) is executing; the directory entry is transiently
      //              in an inconsistent state.  One retry after setImmediate always
      //              sees the completed rename.
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EINVAL') {
        return null // Non-retriable IO error — treat as miss
      }
      if (attempt < 4) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }

  return null
}

/**
 * Write a single artefact into the ACTIVE slot in-place.
 *
 * Used by `publishDataRow` for incremental updates. Uses the same
 * `<final>.tmp` + `rename(2)` trick as `writeArtefact`, so the old HTML is
 * visible to readers up to the exact moment the new HTML is ready.
 *
 * Per-file atomicity is sufficient here because only a single file changes;
 * the two-slot swap is only needed for full publishes where many files change
 * at once.
 */
export async function updateArtefactInPlace(
  uploadsDir: string,
  urlPath: string,
  html: string,
): Promise<void> {
  const slot = await getActiveSlot(uploadsDir)
  const dir = getSlotDir(uploadsDir, slot)
  await writeArtefact(dir, urlPath, html)
}

/**
 * Remove a single artefact from the ACTIVE slot in-place.
 *
 * Used when an incremental publish removes or renames a row (slug change or
 * deletion). No-op if the artefact does not exist. Unsafe paths are ignored
 * silently (path safety: never throw from a remove path).
 *
 * The inactive slot is not touched — any stale file there will be swept by
 * the next `prepareInactiveSlot` call.
 */
export async function removeArtefactInPlace(
  uploadsDir: string,
  urlPath: string,
): Promise<void> {
  const slot = await getActiveSlot(uploadsDir)
  const dir = getSlotDir(uploadsDir, slot)

  let filePath: string
  try {
    filePath = resolveArtefactPath(dir, urlPath)
  } catch {
    // Unsafe path — ignore silently
    return
  }

  // force: true makes this a no-op if the file doesn't exist
  await rm(filePath, { force: true })
}

// ---------------------------------------------------------------------------
// Static asset IO (CSS bundles + runtime JS) — complete static publishing
//
// Published pages reference their CSS at `/_instatic/css/<bundle>-<hash>.css` and
// their JS at `/_instatic/assets/<versionId>/...`. To make the published slot a
// self-contained, server-independent static export, the full publish writes
// those exact files into the slot under the same path. The visitor router
// then serves them straight off disk (no DB, no per-request rebuild). The
// content hash in each filename keeps `Cache-Control: immutable` correct
// across slot swaps.
// ---------------------------------------------------------------------------

/**
 * Write an asset (CSS/JS) into a slot directory at the relative path derived
 * from its public URL path (e.g. `/_instatic/css/style-abc123.css`). Mirrors
 * `writeArtefact`'s tmp + `rename(2)` atomicity. No-op-safe to call repeatedly
 * with identical content-hashed filenames across pages.
 */
export async function writeStaticAsset(
  slotDir: string,
  publicPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const relPath = safeRelPath(publicPath)
  const finalPath = join(slotDir, relPath)
  const rel = relative(slotDir, finalPath)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Static asset path "${publicPath}" escapes the publish root`)
  }
  const tmpPath = `${finalPath}.tmp`
  await mkdir(dirname(finalPath), { recursive: true })
  await writeFile(tmpPath, bytes)
  await rename(tmpPath, finalPath)
}

/**
 * Read a static asset from the active publish slot through the `current`
 * symlink. Returns the raw bytes, or `null` on any miss (no symlink, file
 * absent, unsafe path). Shares `readArtefact`'s retry loop so it survives the
 * brief slot-swap window on every OS.
 */
export async function readStaticAsset(uploadsDir: string, publicPath: string): Promise<Uint8Array | null> {
  let relPath: string
  try {
    relPath = safeRelPath(publicPath)
  } catch {
    return null
  }
  if (relPath === '' || relPath.endsWith('/')) return null

  const filePath = join(getPublishedDir(uploadsDir), 'current', relPath)

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const buffer = await readFile(filePath)
      return new Uint8Array(buffer)
    } catch (err) {
      const code = isNodeError(err) ? err.code : null
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EINVAL') {
        return null
      }
      if (attempt < 4) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }

  return null
}
