/**
 * Pick the ESM entry the site runtime would import for a package manifest.
 *
 * The same rules the publisher's importmap builder applies on disk
 * (`server/publish/runtime/packageImportmap.ts`), so the Dependencies panel
 * can preflight compatibility from registry metadata before anything is
 * installed. The runtime serves package files to the browser as they are,
 * so the order favours whatever is most likely to be ESM:
 *
 *   1. `exports` — string shorthand, `exports['.']`, or a conditions-only map
 *      (`{ import, require, default }` is Node's sugar for `{ ".": … }`), read
 *      for an `import` or `module` condition, one level of nesting.
 *   2. `module` field — ESM by convention.
 *   3. The `default` condition of `exports`. Node would take it before
 *      `module`, but a map that declares no `import` usually points `default`
 *      at CommonJS, which a browser cannot load.
 *   4. `main` field — reported as such so the UI can flag a likely CommonJS entry.
 */
import { isRecord } from '@core/utils/isRecord'
import type { RegistryEsmEntry } from './schemas'

type Manifest = Record<string, unknown>

function relative(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('./') ? value : null
}

const ESM_CONDITIONS = ['import', 'module'] as const
const NESTED_CONDITIONS = ['import', 'module', 'default'] as const

/** The root target of `exports`: the string shorthand, `exports['.']`, or the map itself. */
function exportsRoot(exportsValue: unknown): string | Manifest | null {
  if (typeof exportsValue === 'string') return exportsValue
  if (!isRecord(exportsValue)) return null
  const root = '.' in exportsValue ? exportsValue['.'] : exportsValue
  if (typeof root === 'string') return root
  return isRecord(root) ? root : null
}

function readCondition(root: Manifest, condition: string): string | null {
  const candidate = root[condition]
  const direct = relative(candidate)
  if (direct) return direct
  if (isRecord(candidate)) {
    for (const inner of NESTED_CONDITIONS) {
      const nested = relative(candidate[inner])
      if (nested) return nested
    }
  }
  return null
}

export function pickEsmEntry(manifest: Manifest): RegistryEsmEntry | null {
  const root = exportsRoot(manifest.exports)
  if (typeof root === 'string') {
    const path = relative(root)
    if (path) return { path, source: 'exports' }
  } else if (root) {
    for (const condition of ESM_CONDITIONS) {
      const path = readCondition(root, condition)
      if (path) return { path, source: 'exports' }
    }
  }
  if (typeof manifest.module === 'string' && manifest.module) {
    return { path: manifest.module, source: 'module' }
  }
  if (root && typeof root !== 'string') {
    const path = readCondition(root, 'default')
    if (path) return { path, source: 'exports' }
  }
  if (typeof manifest.main === 'string' && manifest.main) {
    return { path: manifest.main, source: 'main' }
  }
  return null
}

/**
 * Normalise a manifest entry path to the `/relative/path.js` form the
 * importmap builder appends to the package URL.
 */
export function packageEntryUrlPath(entry: RegistryEsmEntry): string {
  return entry.path.startsWith('./') ? entry.path.slice(1) : `/${entry.path}`
}
