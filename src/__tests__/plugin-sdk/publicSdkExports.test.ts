import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import * as sdk from '@core/plugin-sdk'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const scannedRoots = ['src', 'server']
const legacyTypesPath = join('src', 'core', 'plugins', 'types.ts')
// The legacy module path as an import specifier tail — a word boundary after
// `types` keeps `prettier/plugins/typescript` (a real dependency) out.
const legacyTypesImportMarker = new RegExp(`${['plugins', 'types'].join('/')}(?![a-z])`)

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) return collectFiles(fullPath)
    if (!entry.isFile()) return []
    if (!/\.(ts|tsx|md)$/.test(entry.name)) return []
    return [fullPath]
  }))
  return files.flat()
}

describe('public plugin SDK exports', () => {
  it('exports stable runtime constants and helper functions', () => {
    expect(sdk.PLUGIN_API_VERSION).toBe(1)
    expect(typeof sdk.permissionLabel).toBe('function')
    expect(typeof sdk.assertPluginPermission).toBe('function')
  })

  it('exports lifecycle hook names in execution order', () => {
    expect(sdk.SERVER_PLUGIN_LIFECYCLE_HOOKS).toEqual([
      'install',
      'activate',
      'deactivate',
      'uninstall',
      // 'migrate' runs between an old version's deactivate and the new
      // version's activate during an upgrade. Listed last because the array
      // documents EXECUTION order — and migrate is only reachable along the
      // upgrade path, not the install/disable/uninstall path.
      'migrate',
    ])
  })

  it('does not keep legacy plugin type compatibility paths', async () => {
    expect(existsSync(join(repoRoot, legacyTypesPath))).toBe(false)

    const files = (await Promise.all(
      scannedRoots.map((root) => collectFiles(join(repoRoot, root))),
    )).flat()

    const offenders: string[] = []
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      if (legacyTypesImportMarker.test(content)) {
        offenders.push(relative(repoRoot, file))
      }
    }

    expect(offenders).toEqual([])
  })

  it('keeps public plugin types at the SDK boundary', async () => {
    const compatibilityReexports = [
      'src/core/plugins/runtime.ts',
      'src/core/plugins/adminRuntime.ts',
      'server/plugins/runtime.ts',
    ]

    const offenders: string[] = []
    for (const file of compatibilityReexports) {
      const content = await readFile(join(repoRoot, file), 'utf8')
      if (/export\s+type\s+\{[\s\S]*?\}\s+from\s+['"].*plugin-sdk['"]/.test(content)) {
        offenders.push(file)
      }
    }

    expect(offenders).toEqual([])
  })

  it('does not expose raw database access in server route context', async () => {
    const content = await readFile(join(repoRoot, 'src/core/plugin-sdk/types/routes.ts'), 'utf8')
    const routeContext = content.match(
      /export\s+interface\s+ServerPluginRouteContext\s+\{([\s\S]*?)\n\}/,
    )

    expect(routeContext?.[1] ?? '').not.toContain('db:')
  })
})
