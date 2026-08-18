/**
 * Generate the icon manifest the icon picker browses.
 *
 * Reads every vendored `pixel-art-icons` source and extracts its `<path d>`
 * into one DATA file — `src/ui/icons/iconManifest.ts` — mapping icon name to
 * path geometry.
 *
 * Data, not components, on purpose. A picker has to enumerate the whole set,
 * and enumerating 4,000 React components would mean either importing all of
 * them (bundle disaster) or a lazy `Icon` wrapper — the two things
 * `direct-icon-imports.test.ts` exists to prevent. A path string costs a few
 * dozen bytes, renders as inline SVG without any component, and is exactly
 * what `base.svg` already stores and publishes.
 *
 * Deliberately a SEPARATE script from `sync-icons.ts`: that one refuses to run
 * without a checkout of the private upstream catalogue, while this one only
 * ever reads what is already vendored. The manifest therefore stays
 * regenerable on any machine, and grows automatically the day the full
 * catalogue is vendored — the picker itself needs no change.
 *
 *     bun run scripts/build-icon-manifest.ts
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const ICONS_DIR = join(ROOT, 'vendor/pixel-art-icons/icons')
const OUT_DIR = join(ROOT, 'src/ui/icons')
const OUT_FILE = join(OUT_DIR, 'iconManifest.ts')

/** `d="…"` of the single path each icon in this set draws. */
const PATH_RE = /<path\s+d="([^"]+)"/

interface Entry {
  name: string
  d: string
}

function collect(): Entry[] {
  if (!existsSync(ICONS_DIR)) {
    throw new Error(`[build-icon-manifest] No vendored icons at ${ICONS_DIR}`)
  }
  const entries: Entry[] = []
  const skipped: string[] = []

  for (const file of readdirSync(ICONS_DIR).sort()) {
    if (!file.endsWith('.tsx')) continue
    const name = file.replace(/\.tsx$/, '')
    const source = readFileSync(join(ICONS_DIR, file), 'utf8')
    const match = PATH_RE.exec(source)
    if (!match) {
      // Multi-element icons (gradients, groups, strokes) do not reduce to one
      // path. Reported rather than silently dropped — a picker that quietly
      // omits icons is worse than one that is honestly incomplete.
      skipped.push(name)
      continue
    }
    entries.push({ name, d: match[1]! })
  }

  if (skipped.length > 0) {
    console.warn(
      `[build-icon-manifest] ${skipped.length} icon(s) are not a single <path> and were skipped:\n` +
        skipped.map((n) => `  - ${n}`).join('\n'),
    )
  }
  return entries
}

function render(entries: Entry[]): string {
  const rows = entries
    .map((e) => `  { name: '${e.name}', d: '${e.d.replace(/'/g, "\\'")}' },`)
    .join('\n')

  return `/**
 * Icon manifest — GENERATED. Do not edit by hand.
 *
 * Run \`bun run icons:manifest\` after adding or removing a vendored icon.
 *
 * One entry per icon: its kebab-case name (which is also its
 * \`pixel-art-icons/icons/<name>\` module id) and the path geometry it draws
 * on a 24x24 viewBox. The picker searches \`name\` and renders \`d\` directly
 * as inline SVG, so browsing the whole set costs no component imports.
 */

export interface IconManifestEntry {
  /** Kebab-case id, e.g. \`arrow-right\`. Also the module name upstream. */
  name: string
  /** Path geometry on a 24x24 viewBox. */
  d: string
}

export const ICON_MANIFEST: readonly IconManifestEntry[] = [
${rows}
]

/**
 * Inline SVG markup for one icon, in the shape \`base.svg\` stores and
 * publishes. \`currentColor\` rather than a fixed fill so the icon inherits
 * text colour and can be restyled by a class, which is the whole reason the
 * module emits inline SVG instead of an \`<img>\`.
 */
export function iconSvgMarkup(entry: IconManifestEntry): string {
  return \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="\${entry.d}"/></svg>\`
}
`
}

const entries = collect()
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT_FILE, render(entries), 'utf8')
console.log(`[build-icon-manifest] wrote ${entries.length} icons to ${OUT_FILE}`)
