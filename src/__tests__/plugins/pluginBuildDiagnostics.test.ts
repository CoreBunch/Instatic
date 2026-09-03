/**
 * Build diagnostics name the author's file with a 1-based line and column,
 * and the modules pack's generated facade never appears as the location —
 * the position inside the author's module file does.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildPluginPackage, formatBuildLog } from '@core/plugin-build'
import { parsePluginManifest } from '@core/plugins/manifest'

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-'))
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
  }
  return root
}

describe('plugin build diagnostics', () => {
  test('formatBuildLog prefixes file:line:col with a 1-based column', () => {
    expect(
      formatBuildLog({
        message: 'Expected identifier but found "{"',
        position: { file: 'plugins/x/modules/foo.ts', line: 3, column: 17 },
      }),
    ).toBe('plugins/x/modules/foo.ts:3:18: Expected identifier but found "{"')
    expect(formatBuildLog({ message: 'no position', position: null })).toBe('no position')
  })

  test('a syntax error in a module file is reported at that file, not the facade', async () => {
    const root = await workspace({
      'modules/banner.ts': 'export default {\n  id: "x",\n  broken: {{{\n}\n',
    })
    const manifest = parsePluginManifest({
      id: 'site.demo',
      name: 'Demo',
      version: '1.0.1+aaaa1111',
      apiVersion: 1,
      permissions: ['modules.register'],
      resources: [],
      adminPages: [],
      entrypoints: { modules: 'modules/index.js' },
    })
    try {
      await expect(
        buildPluginPackage({
          sourceDir: root,
          outputDir: join(root, '.dist'),
          manifest,
          resolve: { workspaceRoot: root, bareSpecifiers: {} },
        }),
      ).rejects.toThrow(/the modules pack \(modules\/\*\)[\s\S]*modules\/banner\.ts:3:\d+: /)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
