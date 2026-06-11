/**
 * Sync the vendored pixel-art-icons subset.
 *
 * The CMS depends on the `pixel-art-icons` package via deep imports
 *
 *     import { CheckIcon } from 'pixel-art-icons/icons/check'
 *
 * The full upstream catalog (~4,053 icons) is a private, premium asset and
 * cannot be redistributed with the public CMS repo. Bundling all 4k icons
 * would also bloat the public repo for icons we never use. Instead, the CMS
 * carries only the icons it actually imports, vendored as a self-contained
 * npm-shaped package at `vendor/pixel-art-icons/`.
 *
 * That folder is wired into the root `package.json` as
 *
 *     "pixel-art-icons": "file:./vendor/pixel-art-icons"
 *
 * so `bun install` symlinks it into `node_modules/pixel-art-icons/` and every
 * existing import keeps resolving exactly the same way — no SSH key, no
 * private repo access, no source-code churn.
 *
 * This script:
 *
 *   1. Scans `src/` for every `from 'pixel-art-icons/icons/<name>'` import.
 *   2. Reads the matching `<name>.tsx` source files from a sibling checkout
 *      of the upstream private repo (default: `../pixel-art-icons`,
 *      override with `PIXEL_ART_ICONS_SRC`).
 *   3. Copies just those `.tsx` files (plus `types.ts`) into
 *      `vendor/pixel-art-icons/`.
 *   4. Removes any vendored icons that are no longer imported (orphans).
 *   5. Builds `vendor/pixel-art-icons/dist/` via `tsc` so the package looks
 *      identical to the published shape.
 *   6. Stamps `vendor/pixel-art-icons/package.json` with the right exports map.
 *
 * Internal devs run this when they add or remove an icon. CI runs the
 * matching architecture gate `vendor-icons-fresh.test.ts`, which fails loudly
 * with "run `bun run icons:sync`" if the vendored set drifts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dir, '..')
const SRC_DIR = join(ROOT, 'src')
const VENDOR_DIR = join(ROOT, 'vendor/pixel-art-icons')
const VENDOR_ICONS_DIR = join(VENDOR_DIR, 'icons')
const VENDOR_DIST_DIR = join(VENDOR_DIR, 'dist')
const VENDOR_TYPES_FILE = join(VENDOR_DIR, 'types.ts')
const VENDOR_TSCONFIG = join(VENDOR_DIR, 'tsconfig.json')
const VENDOR_PACKAGE_JSON = join(VENDOR_DIR, 'package.json')

const UPSTREAM = resolve(
  process.env.PIXEL_ART_ICONS_SRC ?? join(ROOT, '..', 'pixel-art-icons'),
)
const UPSTREAM_ICONS_DIR = join(UPSTREAM, 'icons')
const UPSTREAM_TYPES_FILE = join(UPSTREAM, 'types.ts')

/**
 * Icons authored in-house, NOT sourced from the upstream catalog.
 *
 * The upstream pixel-art set ships an `underline` glyph but no strikethrough,
 * so `strike` is hand-drawn and committed directly to `vendor/`. In-house
 * icons are never copied from (nor reported as missing in) upstream — but they
 * must still exist as a vendored `.tsx` source, get built into `dist/` like any
 * other icon, and stay imported (an unused in-house icon is an orphan, same as
 * any other). The sync therefore leaves these vendored sources untouched.
 */
const IN_HOUSE_ICONS = new Set(['strike'])

const SCANNED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'])
const IMPORT_RE = /from\s+["']pixel-art-icons\/icons\/([a-z0-9-]+)["']/g
const ICON_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

interface SyncOptions {
  /**
   * When true, do not modify anything; just report what would change.
   * Used by `bun run icons:check` in CI.
   */
  check: boolean
}

// ---------------------------------------------------------------------------
// 1. Collect imported icon names from src/
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, out)
    } else if (SCANNED_EXTS.has(extname(entry))) {
      out.push(full)
    }
  }
  return out
}

function collectImportedIcons(): Set<string> {
  const names = new Set<string>()
  for (const file of walk(SRC_DIR)) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('pixel-art-icons/icons/')) continue
    let m: RegExpExecArray | null
    IMPORT_RE.lastIndex = 0
    while ((m = IMPORT_RE.exec(source)) !== null) {
      const name = m[1]
      if (!ICON_NAME_RE.test(name)) {
        throw new Error(
          `[sync-icons] Invalid icon name "${name}" in ${relative(ROOT, file)}`,
        )
      }
      names.add(name)
    }
  }
  return names
}

// ---------------------------------------------------------------------------
// 2. Copy sources from upstream
// ---------------------------------------------------------------------------

function copyFromUpstream(names: Set<string>, options: SyncOptions): void {
  if (!existsSync(UPSTREAM)) {
    throw new Error(
      `[sync-icons] Upstream pixel-art-icons checkout not found at:\n` +
        `  ${UPSTREAM}\n\n` +
        `Clone the private repo as a sibling of this project, or set\n` +
        `PIXEL_ART_ICONS_SRC to point at your checkout, then re-run\n` +
        `\`bun run icons:sync\`.`,
    )
  }
  if (!existsSync(UPSTREAM_TYPES_FILE)) {
    throw new Error(
      `[sync-icons] Upstream is missing types.ts at ${UPSTREAM_TYPES_FILE}`,
    )
  }

  if (!options.check) {
    mkdirSync(VENDOR_ICONS_DIR, { recursive: true })
    copyFileSync(UPSTREAM_TYPES_FILE, VENDOR_TYPES_FILE)
  }

  const missing: string[] = []
  for (const name of names) {
    // In-house icons have no upstream source; keep the vendored .tsx as-is.
    if (IN_HOUSE_ICONS.has(name)) {
      const vendoredFile = join(VENDOR_ICONS_DIR, `${name}.tsx`)
      if (!existsSync(vendoredFile)) {
        throw new Error(
          `[sync-icons] In-house icon "${name}" is listed in IN_HOUSE_ICONS but ` +
            `vendor/pixel-art-icons/icons/${name}.tsx does not exist. Restore the ` +
            `hand-authored source, or remove the import and the IN_HOUSE_ICONS entry.`,
        )
      }
      continue
    }
    const upstreamFile = join(UPSTREAM_ICONS_DIR, `${name}.tsx`)
    if (!existsSync(upstreamFile)) {
      missing.push(name)
      continue
    }
    if (!options.check) {
      copyFileSync(upstreamFile, join(VENDOR_ICONS_DIR, `${name}.tsx`))
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[sync-icons] ${missing.length} icon(s) imported by src/ are missing in upstream:\n` +
        missing.map((n) => `  - ${n}`).join('\n') +
        `\n\nAdd them to the upstream pixel-art-icons repo, remove the imports, or — ` +
        `if hand-authored — list them in IN_HOUSE_ICONS.`,
    )
  }
}

// ---------------------------------------------------------------------------
// 3. Remove orphan vendored icons (set should equal `names`)
// ---------------------------------------------------------------------------

function removeOrphans(names: Set<string>, options: SyncOptions): string[] {
  if (!existsSync(VENDOR_ICONS_DIR)) return []
  const orphans: string[] = []
  for (const entry of readdirSync(VENDOR_ICONS_DIR)) {
    if (!entry.endsWith('.tsx')) continue
    const name = entry.replace(/\.tsx$/, '')
    if (!names.has(name)) {
      orphans.push(name)
      if (!options.check) {
        rmSync(join(VENDOR_ICONS_DIR, entry))
      }
    }
  }
  return orphans
}

// ---------------------------------------------------------------------------
// 4. Generate package.json + tsconfig.json
// ---------------------------------------------------------------------------

const VENDOR_PACKAGE_JSON_CONTENT = {
  name: 'pixel-art-icons',
  version: '0.0.0-vendored',
  description:
    'Vendored subset of pixel-art-icons. Generated by scripts/sync-icons.ts — do not edit by hand.',
  type: 'module',
  sideEffects: false,
  files: ['dist'],
  exports: {
    './types': {
      types: './dist/types.d.ts',
      default: './dist/types.js',
    },
    './icons/*': {
      types: './dist/icons/*.d.ts',
      default: './dist/icons/*.js',
    },
  },
  peerDependencies: {
    react: '>=18',
  },
}

const VENDOR_TSCONFIG_CONTENT = {
  compilerOptions: {
    target: 'ES2020',
    module: 'esnext',
    moduleResolution: 'bundler',
    jsx: 'react-jsx',
    declaration: true,
    outDir: 'dist',
    rootDir: '.',
    skipLibCheck: true,
    strict: true,
    esModuleInterop: true,
    isolatedModules: true,
    noEmit: false,
    lib: ['ES2020', 'DOM'],
  },
  include: ['types.ts', 'icons/**/*.tsx'],
}

function writePackageJson(options: SyncOptions): void {
  if (options.check) return
  writeFileSync(
    VENDOR_PACKAGE_JSON,
    JSON.stringify(VENDOR_PACKAGE_JSON_CONTENT, null, 2) + '\n',
  )
}

function writeTsconfig(options: SyncOptions): void {
  if (options.check) return
  writeFileSync(
    VENDOR_TSCONFIG,
    JSON.stringify(VENDOR_TSCONFIG_CONTENT, null, 2) + '\n',
  )
}

// ---------------------------------------------------------------------------
// 5. Build dist/ via tsc
// ---------------------------------------------------------------------------

function buildDist(options: SyncOptions): void {
  if (options.check) return

  // Wipe any previous dist before rebuilding so orphans don't linger.
  if (existsSync(VENDOR_DIST_DIR)) {
    rmSync(VENDOR_DIST_DIR, { recursive: true, force: true })
  }

  // Use the root project's tsc; it resolves @types/react via the parent
  // node_modules tree just fine.
  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc')
  if (!existsSync(tsc)) {
    throw new Error(
      `[sync-icons] tsc not found at ${tsc}. Run \`bun install\` first.`,
    )
  }

  const result = spawnSync(tsc, ['-p', VENDOR_TSCONFIG], {
    cwd: VENDOR_DIR,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`[sync-icons] tsc failed (exit ${result.status})`)
  }
}

// ---------------------------------------------------------------------------
// 6. Check mode: verify vendored set matches imports without changing anything
// ---------------------------------------------------------------------------

function listVendoredIcons(): Set<string> {
  const out = new Set<string>()
  if (!existsSync(VENDOR_ICONS_DIR)) return out
  for (const entry of readdirSync(VENDOR_ICONS_DIR)) {
    if (entry.endsWith('.tsx')) out.add(entry.replace(/\.tsx$/, ''))
  }
  return out
}

function listVendoredDist(): Set<string> {
  const out = new Set<string>()
  const distIcons = join(VENDOR_DIST_DIR, 'icons')
  if (!existsSync(distIcons)) return out
  for (const entry of readdirSync(distIcons)) {
    if (entry.endsWith('.js')) out.add(entry.replace(/\.js$/, ''))
  }
  return out
}

function runCheck(): number {
  const imported = collectImportedIcons()
  const sources = listVendoredIcons()
  const dist = listVendoredDist()

  const missingSrc = [...imported].filter((n) => !sources.has(n)).sort()
  const orphanSrc = [...sources].filter((n) => !imported.has(n)).sort()
  const missingDist = [...imported].filter((n) => !dist.has(n)).sort()
  const orphanDist = [...dist].filter((n) => !imported.has(n)).sort()

  const drift =
    missingSrc.length + orphanSrc.length + missingDist.length + orphanDist.length

  if (drift === 0) {
    console.error(
      `[icons:check] vendor/pixel-art-icons is fresh (${imported.size} icons).`,
    )
    return 0
  }

  console.error('[icons:check] vendor/pixel-art-icons is stale:')
  if (missingSrc.length > 0) {
    console.error(
      `  missing source files (icons/${missingSrc.length}):\n` +
        missingSrc.map((n) => `    - icons/${n}.tsx`).join('\n'),
    )
  }
  if (orphanSrc.length > 0) {
    console.error(
      `  orphan source files (icons/${orphanSrc.length}):\n` +
        orphanSrc.map((n) => `    - icons/${n}.tsx`).join('\n'),
    )
  }
  if (missingDist.length > 0) {
    console.error(
      `  missing built files (dist/icons/${missingDist.length}):\n` +
        missingDist.map((n) => `    - dist/icons/${n}.js`).join('\n'),
    )
  }
  if (orphanDist.length > 0) {
    console.error(
      `  orphan built files (dist/icons/${orphanDist.length}):\n` +
        orphanDist.map((n) => `    - dist/icons/${n}.js`).join('\n'),
    )
  }
  console.error(
    `\n  Run \`bun run icons:sync\` to refresh vendor/pixel-art-icons/.\n`,
  )
  return 1
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): number {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  if (check) return runCheck()

  const imported = collectImportedIcons()
  if (imported.size === 0) {
    throw new Error(
      `[sync-icons] No \`pixel-art-icons/icons/<name>\` imports found in src/. ` +
        `That can't be right — refusing to wipe vendor/pixel-art-icons/.`,
    )
  }

  console.error(
    `[sync-icons] ${imported.size} unique icon(s) imported by src/.`,
  )

  // Make sure vendor dir + skeleton exist
  mkdirSync(VENDOR_DIR, { recursive: true })

  copyFromUpstream(imported, { check: false })
  const orphans = removeOrphans(imported, { check: false })
  if (orphans.length > 0) {
    console.error(
      `[sync-icons] removed ${orphans.length} orphan icon(s): ${orphans.join(', ')}`,
    )
  }
  writePackageJson({ check: false })
  writeTsconfig({ check: false })
  buildDist({ check: false })

  console.error(
    `[sync-icons] vendor/pixel-art-icons/ is fresh — ${imported.size} icons + types.`,
  )

  // Bun's `file:` deps are copied into node_modules at install time, so
  // re-running install after a sync is required for the new icons to be
  // visible to dev/build/test. Do it for the developer.
  console.error(`[sync-icons] refreshing node_modules/pixel-art-icons/ ...`)
  const bunInstall = spawnSync('bun', ['install'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (bunInstall.status !== 0) {
    throw new Error(
      `[sync-icons] \`bun install\` failed (exit ${bunInstall.status}). Run it manually.`,
    )
  }
  return 0
}

// Ensure unused-import lint doesn't trip on dirname (used implicitly via Node typing in some configs).
void dirname

process.exit(main())
