/**
 * googleFontsInstaller — server-side installer for Google Fonts.
 *
 * Workflow:
 *   1. The editor sends `{ family, variants[], subsets[] }` to the install endpoint.
 *   2. We hit the public Google Fonts CSS2 endpoint per (variant, subset) pair to
 *      retrieve a single `@font-face` rule that points at a CDN-hosted woff2 URL.
 *      We never give that URL to the browser — it stays server-side only.
 *   3. We download each woff2, write it to `<uploads>/fonts/<slug>/...woff2`.
 *   4. We return a `FontEntry` ready for the client to merge into `site.settings.fonts`.
 *
 * The hit Google Fonts surface (`https://fonts.googleapis.com/css2?...`) is the
 * keyless one — it doesn't require an API key, only a UA hint that supports
 * woff2 (we send a modern Chrome UA). The font binaries live at
 * `https://fonts.gstatic.com/s/...` and are CC/OFL licensed for redistribution.
 *
 * This module does network + file IO only — it never touches the database, so
 * it lives under `server/fonts/`, not in the `server/repositories/` data layer.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { FontEntry, FontFile, FontFileFormat } from '@core/fonts'
import { familySlug } from '@core/fonts'
import { compareVariants, parseVariant, variantsToCss2Axis } from '@core/fonts'
import { findGoogleFont } from '@core/fonts'
import { mapWithConcurrency } from '../util/mapWithConcurrency'

/**
 * UA spoof: Google's CSS2 endpoint inspects the User-Agent header to decide which
 * font format URL to inline. Modern Chrome on Linux gets the woff2 URL we need.
 * Without a UA the response defaults to .ttf, which is much larger.
 */
const WOFF2_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const GOOGLE_CSS2_BASE = 'https://fonts.googleapis.com/css2'
const GSTATIC_HOST_RE = /^https:\/\/fonts\.gstatic\.com\//

export class FontInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FontInstallError'
  }
}

interface InstallGoogleFontInput {
  family: string
  variants: readonly string[]
  subsets: readonly string[]
}

/**
 * Sanitise + cross-check the install request against the bundled Google Fonts
 * directory. The request fails closed: only families we ship in the snapshot
 * can be installed, and only their advertised variants/subsets are honoured.
 */
function resolveGoogleRequest(input: InstallGoogleFontInput): {
  family: string
  category: string
  variants: string[]
  /** The user's selected subsets, intersected with the family's advertised list. */
  subsets: string[]
  /** Full list of subsets the family advertises — needed to attribute leading
      unnamed `@font-face` blocks (CJK families) to their primary subset. */
  familySubsets: string[]
} {
  const family = (input.family ?? '').trim()
  if (!family) throw new FontInstallError('Missing font family')
  const directoryEntry = findGoogleFont(family)
  if (!directoryEntry) {
    throw new FontInstallError(`Unknown Google font family: ${family}`)
  }

  const allowedVariants = new Set(directoryEntry.variants)
  const allowedSubsets = new Set(directoryEntry.subsets)

  const variants = (input.variants ?? [])
    .filter((v): v is string => typeof v === 'string' && allowedVariants.has(v))
    .filter((v) => parseVariant(v) !== null)
  const subsets = (input.subsets ?? [])
    .filter((s): s is string => typeof s === 'string' && allowedSubsets.has(s))

  if (variants.length === 0) {
    throw new FontInstallError(`No supported variants requested for ${family}`)
  }
  if (subsets.length === 0) {
    throw new FontInstallError(`No supported subsets requested for ${family}`)
  }

  return {
    family,
    category: directoryEntry.category,
    variants: Array.from(new Set(variants)).sort(compareVariants),
    subsets: Array.from(new Set(subsets)),
    familySubsets: [...directoryEntry.subsets],
  }
}

/**
 * Cache for CSS2 responses keyed by `${family}::${axisSpec}`. The dialog
 * estimates a font's size on every selection toggle (debounced 300ms); without
 * a cache, each toggle round-trips to Google's CSS endpoint. Toggling subsets
 * doesn't change `axisSpec`, so the cache nets a hit ratio of nearly 100% for
 * the common interactive flow (user picks variants once, then plays with
 * subsets). Entries are stable for a Google fonts release, which is well
 * within the lifetime of a single CMS process.
 *
 * We store the in-flight Promise (not the resolved string) so a burst of
 * concurrent calls for the same key collapse to a single upstream request.
 */
const cssResponseCache = new Map<string, Promise<string>>()

/**
 * Pull the full CSS2 stylesheet for the family × all-requested-variants in a
 * single request. We deliberately do NOT pass `&subset=` — empirically the
 * CSS2 endpoint ignores that parameter and always returns every subset for
 * the requested family/axis. Filtering happens client-side, keyed off the
 * `/* <subset> *\/` comments Google emits before each `@font-face` block.
 */
async function fetchFamilyCss(family: string, axisSpec: string): Promise<string> {
  const cacheKey = `${family}::${axisSpec}`
  const cached = cssResponseCache.get(cacheKey)
  if (cached) return cached

  const url = `${GOOGLE_CSS2_BASE}?family=${encodeURIComponent(family)}:${axisSpec}&display=swap`
  const promise = fetch(url, { headers: { 'User-Agent': WOFF2_UA } }).then(async (res) => {
    if (!res.ok) {
      // Drop the failed promise from the cache so the next attempt can retry —
      // we don't want a transient Google 5xx to brick the dialog forever.
      cssResponseCache.delete(cacheKey)
      throw new FontInstallError(`Google Fonts CSS request failed for ${family} (HTTP ${res.status})`)
    }
    return res.text()
  })
  // Park the in-flight promise immediately so concurrent callers join it.
  cssResponseCache.set(cacheKey, promise)
  // Also evict on failure (the .then chain above doesn't replace what we just set).
  promise.catch(() => cssResponseCache.delete(cacheKey))
  return promise
}

/** @internal exported only for unit tests in `src/__tests__/server/fontsCss.test.ts`. */
interface ParsedFace {
  weight: number
  italic: boolean
  url: string
  /** The subset name attributed to this slice via the preceding `/* name *\/` comment. */
  subset: string
  /**
   * The CSS `unicode-range` value from this `@font-face` block, or undefined if
   * Google omitted one. Google's CSS2 endpoint shards a single subset across
   * multiple `@font-face` blocks each restricted to a different `unicode-range`
   * — we round-trip the value verbatim so the published page's font requests
   * are split the same way (browsers download only the slices they need).
   */
  unicodeRange?: string
}

/**
 * Subset names follow the same shape as Google's directory entries: lowercase
 * latin letters / digits / hyphens. We use this to filter the comment-stream
 * tokens; anything outside that shape (numeric shard markers like `[0]`,
 * Google's internal axis labels, whitespace, etc.) is ignored without
 * changing the active subset.
 */
const SUBSET_NAME_RE = /^[a-z][a-z0-9-]*$/

/**
 * Walk a CSS2 response in source order and attribute each `@font-face` block
 * to the most recently seen `/* <subset> *\/` comment. Blocks that appear
 * before any subset comment are tagged with `primarySubset` — that's the
 * family's "main" subset (e.g. "japanese" for Noto Sans JP, where Google
 * emits ~120 numbered shards before any named comment).
 *
 * Caller filters faces by `weight × italic` (variant) and `subset` against
 * the user's selection.
 */
/** @internal exported for tests; callers should use `installGoogleFont` / `estimateGoogleFont`. */
export function parseCss2Faces(css: string, primarySubset: string): ParsedFace[] {
  const faces: ParsedFace[] = []
  // Single regex matches either a comment or a font-face block, so we keep
  // source order and can update the active subset as we walk forward.
  const tokenRe = /\/\*([\s\S]*?)\*\/|@font-face\s*\{([^}]+)\}/g

  // Google's CSS2 emits one full pass per (weight × italic): all primary-
  // subset shards first, then each named subset. The next variant repeats
  // that pattern. We track three pieces of state so we can attribute each
  // block correctly:
  //   - `pendingSubset`: the subset named by a comment AFTER the previous
  //     block — wins for the next block, then clears.
  //   - `activeSubset`:  the subset of the previous block, used to continue
  //     a multi-shard run within a single variant pass.
  //   - `prevWeight` / `prevItalic`: detect when we've crossed into a new
  //     variant pass; if we cross AND no comment named a subset for the new
  //     block, the unnamed shards belong to the primary subset.
  let pendingSubset: string | null = null
  let activeSubset = primarySubset
  let prevWeight: number | null = null
  let prevItalic: boolean | null = null

  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(css)) !== null) {
    if (match[1] !== undefined) {
      const trimmed = match[1].trim()
      if (SUBSET_NAME_RE.test(trimmed)) pendingSubset = trimmed
      continue
    }
    const block = match[2]
    const weightMatch = /font-weight\s*:\s*(\d+)/.exec(block)
    const styleMatch = /font-style\s*:\s*(italic|normal)/.exec(block)
    const urlMatch = /url\((https:\/\/[^)]+\.woff2)\)/.exec(block)
    const rangeMatch = /unicode-range\s*:\s*([^;}]+)/.exec(block)
    if (!weightMatch || !styleMatch || !urlMatch) continue
    if (!GSTATIC_HOST_RE.test(urlMatch[1])) continue

    const weight = Number(weightMatch[1])
    const italic = styleMatch[1] === 'italic'
    const variantChanged =
      prevWeight !== null && (weight !== prevWeight || italic !== prevItalic)

    if (pendingSubset !== null) {
      activeSubset = pendingSubset
    } else if (variantChanged) {
      // New variant pass with no name comment — these are primary-subset shards.
      activeSubset = primarySubset
    }
    // else: continuing inside the same variant pass with no new comment;
    // hold whatever activeSubset we last set.

    const unicodeRange = rangeMatch?.[1].trim()
    faces.push({
      weight,
      italic,
      url: urlMatch[1],
      subset: activeSubset,
      ...(unicodeRange ? { unicodeRange } : {}),
    })

    pendingSubset = null
    prevWeight = weight
    prevItalic = italic
  }
  return faces
}

/**
 * The "primary" subset is the one assigned to leading `@font-face` blocks
 * that appear before any `/* name *\/` comment in the CSS2 response. We
 * derive it as the difference between the family's advertised subset list
 * and the named subsets observed in the CSS — for fonts like Roboto, every
 * subset is named in the CSS so this returns the empty string and any
 * leading unnamed blocks (rare) are filtered out by the install/estimate.
 */
/** @internal exported for tests; callers should use `installGoogleFont` / `estimateGoogleFont`. */
export function computePrimarySubset(familySubsets: readonly string[], css: string): string {
  const named = new Set<string>()
  const commentRe = /\/\*([\s\S]*?)\*\//g
  let match: RegExpExecArray | null
  while ((match = commentRe.exec(css)) !== null) {
    const trimmed = match[1].trim()
    if (SUBSET_NAME_RE.test(trimmed)) named.add(trimmed)
  }
  return familySubsets.find((s) => !named.has(s)) ?? ''
}

async function downloadBinary(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { 'User-Agent': WOFF2_UA } })
  if (!res.ok) {
    throw new FontInstallError(`Failed to download font binary (HTTP ${res.status})`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * In-process cache for woff2 byte sizes keyed by gstatic URL. The dialog calls
 * `estimateGoogleFont` repeatedly as the user toggles variants/subsets — caching
 * keeps that interactive without spamming the gstatic CDN. Each gstatic URL is
 * content-addressed (immutable for a given family revision), so a process-lived
 * map is safe.
 */
const woff2SizeCache = new Map<string, number>()

async function fetchWoff2Size(url: string): Promise<number | null> {
  const cached = woff2SizeCache.get(url)
  if (cached != null) return cached
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': WOFF2_UA },
    })
    if (!res.ok) return null
    const len = res.headers.get('content-length')
    if (!len) return null
    const bytes = Number(len)
    if (!Number.isFinite(bytes) || bytes <= 0) return null
    woff2SizeCache.set(url, bytes)
    return bytes
  } catch {
    return null
  }
}

interface EstimateGoogleFontResult {
  /** Sum of `Content-Length` across every resolved woff2 URL. */
  totalBytes: number
  /** Number of woff2 files whose size contributed to `totalBytes`. */
  fileCount: number
}

/**
 * Resolve a request to the concrete list of `@font-face` slices Google would
 * actually return for the user's selection. The CSS2 endpoint returns every
 * subset in one response (the `&subset=` parameter is ignored), so we fetch
 * once and filter by:
 *   1. variant — drop slices Google occasionally throws in for variable fonts.
 *   2. subset  — keep only slices attributed to a subset the user picked.
 */
async function resolveFaces(input: InstallGoogleFontInput): Promise<{
  resolved: ReturnType<typeof resolveGoogleRequest>
  faces: ParsedFace[]
}> {
  const resolved = resolveGoogleRequest(input)
  const axisSpec = variantsToCss2Axis(resolved.variants)
  if (!axisSpec) throw new FontInstallError('No usable variants for Google Fonts CSS request')

  const css = await fetchFamilyCss(resolved.family, axisSpec)
  const primarySubset = computePrimarySubset(resolved.familySubsets, css)
  const requestedSubsets = new Set(resolved.subsets)
  const requestedVariants = new Set(resolved.variants)

  const faces = parseCss2Faces(css, primarySubset).filter((face) => {
    const variant = face.italic ? `${face.weight}italic` : String(face.weight)
    return requestedVariants.has(variant) && requestedSubsets.has(face.subset)
  })
  return { resolved, faces }
}

/**
 * Estimate the on-disk download size for a (family × variants × subsets) selection
 * without actually downloading any binaries. One CSS2 fetch per call (cached
 * across calls for the same axis), then a parallel HEAD for every matched
 * woff2 URL. CDNs handle bursts of HEADs trivially and we never issue more
 * than ~120 in a worst-case CJK install — orders of magnitude below the
 * gstatic per-host concurrency limit.
 *
 * Cached HEAD results (`woff2SizeCache`) collapse repeated estimates for the
 * same selection to zero network work after the first call, so the dialog
 * stays responsive as the user toggles checkboxes.
 *
 * Returns 0/0 when no faces resolve.
 */
export async function estimateGoogleFont(
  input: InstallGoogleFontInput,
): Promise<EstimateGoogleFontResult> {
  const { faces } = await resolveFaces(input)

  const sizes = await Promise.all(faces.map((face) => fetchWoff2Size(face.url)))
  let totalBytes = 0
  let fileCount = 0
  for (const size of sizes) {
    if (size == null) continue
    totalBytes += size
    fileCount += 1
  }
  return { totalBytes, fileCount }
}

/**
 * Per-slice filename inside the family directory:
 *   `<weight><i?>-<subset>-<sliceIndex>.woff2`
 *   → e.g. `400-latin-0.woff2`, `400-latin-1.woff2`, `700italic-latin-ext-0.woff2`.
 *
 * Google's CSS2 endpoint returns multiple `@font-face` blocks per
 * (variant × subset) request, each pinned to a different `unicode-range`
 * slice — they all need their own file or they'd collide on disk. The slice
 * index matches the order Google emits them, so re-installing the same
 * selection produces deterministic filenames.
 *
 * Subset is restricted to the bundled directory's allow-list before this
 * function runs, so it's already a known token (latin, latin-ext, etc.) — but
 * we still strip anything outside `[a-z0-9-]` defensively in case Google adds
 * a future subset name we don't know about.
 */
function fontSliceFilename(variant: string, subset: string, sliceIndex: number): string {
  const safeSubset = subset.toLowerCase().replace(/[^a-z0-9-]/g, '')
  return `${variant}-${safeSubset || 'latin'}-${sliceIndex}.woff2`
}

/**
 * Cap on concurrent woff2 downloads during install. CJK families (Noto Sans
 * KR, JP, SC, TC) emit 100+ shards per variant; without bounded concurrency a
 * 5-variant Korean install would either serialize for minutes or open 600+
 * sockets at once. 8 in flight saturates a typical residential link without
 * tripping gstatic's per-host limits.
 */
const INSTALL_CONCURRENCY = 8

export async function installGoogleFont(
  input: InstallGoogleFontInput,
  uploadsDir: string,
): Promise<FontEntry> {
  const { resolved, faces } = await resolveFaces(input)
  const slug = familySlug(resolved.family)
  if (!slug) throw new FontInstallError('Family name has no usable slug')

  const targetDir = join(uploadsDir, 'fonts', slug)
  // Wipe any previous install for this family so stale slices from an older
  // selection / older Google revision don't linger on disk. Re-install is the
  // only path that touches this directory, so a clean slate is the right
  // invariant.
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })

  // Pre-compute the FontFile metadata sequentially so slice indexes within a
  // (variant, subset) pair stay deterministic regardless of which downloads
  // win the parallel race below.
  interface PlannedFile {
    file: FontFile
    sourceUrl: string
    onDiskPath: string
  }
  const plan: PlannedFile[] = []
  const sliceCounters = new Map<string, number>()
  for (const face of faces) {
    const variant = face.italic ? `${face.weight}italic` : String(face.weight)
    const counterKey = `${variant}::${face.subset}`
    const sliceIndex = sliceCounters.get(counterKey) ?? 0
    sliceCounters.set(counterKey, sliceIndex + 1)
    const filename = fontSliceFilename(variant, face.subset, sliceIndex)
    plan.push({
      sourceUrl: face.url,
      onDiskPath: join(targetDir, filename),
      file: {
        variant,
        subset: face.subset,
        path: `/uploads/fonts/${slug}/${filename}`,
        format: 'woff2',
        ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
      },
    })
  }

  // Download + write in bounded parallel; one slow URL no longer blocks the
  // others. A failing download bubbles a `FontInstallError` and the partially
  // populated directory is wiped at the end.
  await mapWithConcurrency(plan, INSTALL_CONCURRENCY, async (entry) => {
    const bytes = await downloadBinary(entry.sourceUrl)
    await writeFile(entry.onDiskPath, bytes)
  })

  const files = plan.map((p) => p.file)

  if (files.length === 0) {
    // Cleanup: empty directory is meaningless on disk.
    await rm(targetDir, { recursive: true, force: true })
    throw new FontInstallError(`Google Fonts returned no woff2 files for ${resolved.family}`)
  }

  const now = Date.now()
  return {
    id: nanoid(),
    source: 'google',
    family: resolved.family,
    variants: resolved.variants,
    subsets: resolved.subsets,
    files,
    category: resolved.category,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Remove every woff2 file for a family slug from disk. Called by the delete
 * endpoint after the client has dropped the entry from `site.settings.fonts`.
 * Idempotent — missing directory is not an error.
 */
export async function uninstallFontFamily(
  family: string,
  uploadsDir: string,
): Promise<void> {
  const slug = familySlug(family)
  if (!slug) return
  await rm(join(uploadsDir, 'fonts', slug), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Custom fonts (uploaded via the media library)
// ---------------------------------------------------------------------------

/** Font container MIME → our canonical `FontFileFormat`. */
const FONT_FORMAT_FOR_MIME: Record<string, FontFileFormat> = {
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
}

/** Resolve a media asset's MIME to a font format, or null if it isn't a font. */
export function fontFormatForMime(mimeType: string): FontFileFormat | null {
  return FONT_FORMAT_FOR_MIME[mimeType] ?? null
}

/**
 * One resolved custom-font file — the media asset has already been looked up by
 * the handler so the `path` (public URL) and `format` (from the sniffed MIME)
 * are server-trusted, and the requested `variant` validated.
 */
export interface ResolvedCustomFontFile {
  variant: string
  format: FontFileFormat
  /** Public URL of the uploaded media asset (e.g. `/uploads/media/abc.woff2`). */
  path: string
  /** The backing media asset id — kept on the FontFile so the entry survives
   *  storage migration and external URLs are trusted at the CSS boundary. */
  mediaAssetId: string
}

/**
 * Assemble a `FontEntry` (`source: 'custom'`) from resolved media-backed files.
 *
 * Pure + synchronous — the handler does the async media lookups + validation,
 * then hands fully-resolved files here so this stays testable without a DB.
 * Variants are deduped + sorted canonically; `subset` is fixed to `'latin'`
 * since custom uploads aren't sliced by subset.
 */
export function assembleCustomFontEntry(input: {
  family: string
  files: readonly ResolvedCustomFontFile[]
}): FontEntry {
  const family = input.family.trim()
  if (!family) throw new FontInstallError('Missing font family')
  if (input.files.length === 0) {
    throw new FontInstallError('A custom font needs at least one uploaded file')
  }

  const files: FontFile[] = input.files.map((f) => ({
    variant: f.variant,
    subset: 'latin',
    path: f.path,
    format: f.format,
    mediaAssetId: f.mediaAssetId,
  }))

  const variants = Array.from(new Set(files.map((f) => f.variant))).sort(compareVariants)

  const now = Date.now()
  return {
    id: nanoid(),
    source: 'custom',
    family,
    variants,
    subsets: ['latin'],
    files,
    createdAt: now,
    updatedAt: now,
  }
}
