/**
 * Generate the icon packs the icon picker browses.
 *
 * Two sources, one output shape:
 *   - the vendored `pixel-art-icons` set (read from `vendor/`), and
 *   - selected `react-icons` families (rendered from the dev dependency).
 *
 * Each pack becomes `src/ui/icons/packs/<id>.ts` holding plain DATA, plus a
 * `registry.ts` the picker imports eagerly for the pack switcher. Pack bodies
 * are loaded LAZILY, one at a time — the full react-icons catalogue is ~50,000
 * icons, and no browser should receive that up front.
 *
 * ## Why data, and why react-icons never ships
 *
 * `react-icons` is a **devDependency**. It is rendered here at build time and
 * never imported by anything under `src/`, so it contributes nothing to the
 * browser bundle: what ships is inline SVG markup, which is what `base.svg`
 * already stores, sanitises through DOMPurify, and publishes. That also keeps
 * the picker clear of the two failure modes `direct-icon-imports.test.ts`
 * exists to prevent — there is no mass component import and no lazy `Icon`
 * wrapper anywhere.
 *
 * ## Why whole markup rather than a path
 *
 * The first version stored just `d`. That is wrong across families: Feather
 * and Lucide are STROKE-based (`stroke="currentColor" fill="none"`), so a
 * bare path renders as a filled blob. Storing the rendered `<svg>` verbatim —
 * minus the fixed `1em` sizing, so CSS can size it — is the only form that
 * survives every family without per-family special-casing.
 *
 *     bun run icons:manifest
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

const ROOT = resolve(import.meta.dir, '..')
const VENDOR_ICONS_DIR = join(ROOT, 'vendor/pixel-art-icons/icons')
const OUT_DIR = join(ROOT, 'src/ui/icons/packs')

/**
 * react-icons families to generate, and what to call them in the UI.
 *
 * A curated list, not every family the package ships: each one is committed
 * generated data, and all ~30 would add tens of megabytes to the repo for
 * families most sites never touch. Adding one is a line here plus a re-run.
 */
const REACT_ICON_PACKS: ReadonlyArray<{ id: string; module: string; label: string }> = [
  { id: 'fi', module: 'react-icons/fi', label: 'Feather' },
  { id: 'fa6', module: 'react-icons/fa6', label: 'Font Awesome 6' },
  { id: 'md', module: 'react-icons/md', label: 'Material Design' },
  { id: 'bs', module: 'react-icons/bs', label: 'Bootstrap' },
  { id: 'io5', module: 'react-icons/io5', label: 'Ionicons 5' },
  { id: 'ri', module: 'react-icons/ri', label: 'Remix' },
  { id: 'tb', module: 'react-icons/tb', label: 'Tabler' },
  { id: 'si', module: 'react-icons/si', label: 'Simple Icons (brands)' },
]

interface Entry {
  name: string
  svg: string
}

/** Strip the fixed `1em` sizing react-icons bakes in so CSS can size the glyph. */
function normalizeMarkup(markup: string): string {
  return markup
    .replace(/\s(?:height|width)="1em"/g, '')
    .replace(/\s+>/g, '>')
}

/** `FiArrowRight` → `arrow-right`, so search reads the way a person types. */
function kebab(exportName: string, packId: string): string {
  const prefix = packId.charAt(0).toUpperCase() + packId.slice(1)
  const bare = exportName.startsWith(prefix) ? exportName.slice(prefix.length) : exportName
  return bare
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/^-+/, '')
}

/** The in-house set: single-path sources, read straight off disk. */
function collectPixelPack(): Entry[] {
  if (!existsSync(VENDOR_ICONS_DIR)) return []
  const pathRe = /<path\s+d="([^"]+)"/
  const entries: Entry[] = []
  for (const file of readdirSync(VENDOR_ICONS_DIR).sort()) {
    if (!file.endsWith('.tsx')) continue
    const match = pathRe.exec(readFileSync(join(VENDOR_ICONS_DIR, file), 'utf8'))
    if (!match) continue
    entries.push({
      name: file.replace(/\.tsx$/, ''),
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="${match[1]}"/></svg>`,
    })
  }
  return entries
}

/**
 * Render every icon a react-icons family exports. Rendering rather than
 * parsing their internal tree format: the output is the contract, so this
 * keeps working if they change how icons are built internally.
 */
async function collectReactPack(moduleId: string, packId: string): Promise<Entry[]> {
  const mod: Record<string, unknown> = await import(moduleId)
  const entries: Entry[] = []
  for (const exportName of Object.keys(mod).sort()) {
    const Component = mod[exportName]
    if (typeof Component !== 'function') continue
    try {
      const markup = renderToStaticMarkup((Component as (p: object) => never)({}))
      if (typeof markup !== 'string' || !markup.startsWith('<svg')) continue
      entries.push({ name: kebab(exportName, packId), svg: normalizeMarkup(markup) })
    } catch {
      // A single icon that refuses to render must not lose the whole family.
      continue
    }
  }
  return entries
}

function renderPackFile(id: string, label: string, entries: Entry[]): string {
  const rows = entries
    .map((e) => `  ['${e.name.replace(/'/g, "\\'")}', '${e.svg.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'],`)
    .join('\n')
  return `/**
 * Icon pack "${label}" — GENERATED. Do not edit by hand.
 * Run \`bun run icons:manifest\` to regenerate.
 *
 * Tuples rather than objects: at this size the key names would repeat once per
 * icon and cost more than the data.
 */
export const PACK_ID = '${id}'
export const ICONS: ReadonlyArray<readonly [name: string, svg: string]> = [
${rows}
]
`
}

function renderRegistry(packs: ReadonlyArray<{ id: string; label: string; count: number }>): string {
  const rows = packs
    .map(
      (p) =>
        `  { id: '${p.id}', label: '${p.label.replace(/'/g, "\\'")}', count: ${p.count},\n` +
        `    load: () => import('./${p.id}').then((m) => m.ICONS) },`,
    )
    .join('\n')
  return `/**
 * Icon pack registry — GENERATED. Do not edit by hand.
 * Run \`bun run icons:manifest\` to regenerate.
 *
 * Only this file is imported eagerly. Each pack's icons arrive through its
 * own \`load()\` dynamic import, so opening the picker costs one small list
 * and browsing one family costs exactly that family.
 */
export interface IconPack {
  id: string
  label: string
  count: number
  load: () => Promise<ReadonlyArray<readonly [name: string, svg: string]>>
}

export const ICON_PACKS: readonly IconPack[] = [
${rows}
]
`
}

// ---------------------------------------------------------------------------

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const summary: Array<{ id: string; label: string; count: number }> = []

const pixel = collectPixelPack()
if (pixel.length > 0) {
  writeFileSync(join(OUT_DIR, 'pixel.ts'), renderPackFile('pixel', 'Pixel Art', pixel), 'utf8')
  summary.push({ id: 'pixel', label: 'Pixel Art', count: pixel.length })
  console.log(`[icons:manifest] pixel — ${pixel.length}`)
}

for (const pack of REACT_ICON_PACKS) {
  try {
    const entries = await collectReactPack(pack.module, pack.id)
    if (entries.length === 0) {
      console.warn(`[icons:manifest] ${pack.id} — no icons, skipped`)
      continue
    }
    writeFileSync(join(OUT_DIR, `${pack.id}.ts`), renderPackFile(pack.id, pack.label, entries), 'utf8')
    summary.push({ id: pack.id, label: pack.label, count: entries.length })
    console.log(`[icons:manifest] ${pack.id} — ${entries.length}`)
  } catch (err) {
    console.warn(`[icons:manifest] ${pack.id} — failed:`, err instanceof Error ? err.message : err)
  }
}

writeFileSync(join(OUT_DIR, 'registry.ts'), renderRegistry(summary), 'utf8')
const total = summary.reduce((n, p) => n + p.count, 0)
console.log(`[icons:manifest] ${summary.length} packs, ${total} icons`)
