/**
 * Import containment for workspace plugin builds — the resolve plugin must
 * fail closed: every import originating inside the workspace resolves inside
 * it; bare specifiers are rejected unless mapped; absolute paths and
 * upward-relative escapes throw. Without this, draft code could embed host
 * files (env files, DB files) into a bundle and exfiltrate them through the
 * plugin's own public routes.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertNoBuildTimeMacros, buildPluginPackage } from '@core/plugin-build'
import { parsePluginManifest } from '@core/plugins/manifest'

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'containment-'))
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
  }
  return root
}

const MANIFEST = parsePluginManifest({
  id: 'site.demo',
  name: 'Demo',
  version: '1.0.1+aaaa1111',
  apiVersion: 1,
  permissions: [],
  resources: [],
  adminPages: [],
  entrypoints: { server: 'server/index.js' },
})

const SDK_ENTRY = resolve(import.meta.dir, '../../core/plugin-sdk/index.ts')

describe('plugin build import containment', () => {
  test('relative import inside the workspace bundles fine', async () => {
    const root = await workspace({
      'server/index.ts': "import { x } from '../shared/util'\nexport function activate() { return x }",
      'shared/util.ts': 'export const x = 1',
    })
    try {
      const out = join(root, '.dist')
      const result = await buildPluginPackage({
        sourceDir: root,
        outputDir: out,
        manifest: MANIFEST,
        resolve: { workspaceRoot: root, bareSpecifiers: {} },
      })
      expect(result.files).toContain('server/index.js')
      expect(existsSync(join(out, 'server/index.js'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('upward escape outside the workspace fails the build', async () => {
    const root = await workspace({
      'server/index.ts': "import secret from '../../outside'\nexport function activate() { return secret }",
    })
    await writeFile(join(root, '..', 'outside.ts'), 'export default 42', 'utf8')
    try {
      await expect(
        buildPluginPackage({
          sourceDir: root,
          outputDir: join(root, '.dist'),
          manifest: MANIFEST,
          resolve: { workspaceRoot: root, bareSpecifiers: {} },
        }),
      ).rejects.toThrow(/outside the plugin workspace/)
    } finally {
      await rm(join(root, '..', 'outside.ts'), { force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  test('absolute-path import-attribute payload fails the build', async () => {
    const root = await workspace({
      'server/index.ts': "import x from '/etc/hosts' with { type: 'text' }\nexport function activate() { return x }",
    })
    try {
      await expect(
        buildPluginPackage({
          sourceDir: root,
          outputDir: join(root, '.dist'),
          manifest: MANIFEST,
          resolve: { workspaceRoot: root, bareSpecifiers: {} },
        }),
      ).rejects.toThrow(/outside the plugin workspace/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a build-time macro import fails the build before the macro runs', async () => {
    // Bun evaluates `with { type: 'macro' }` imports in the host process at
    // bundle time. The macro module resolves INSIDE the workspace, so path
    // containment cannot catch it — the source scan must refuse it first.
    const marker = join(tmpdir(), `containment-macro-${process.pid}-${Date.now()}.txt`)
    const root = await workspace({
      'server/m.ts':
        `import { writeFileSync } from 'node:fs'\n` +
        `export function pwn() { writeFileSync(${JSON.stringify(marker)}, 'ran'); return 1 }\n`,
      'server/index.ts':
        "import { pwn } from './m.ts' with { type: 'macro' }\nexport function activate() { return pwn() }\n",
    })
    try {
      await expect(
        buildPluginPackage({
          sourceDir: root,
          outputDir: join(root, '.dist'),
          manifest: MANIFEST,
          resolve: { workspaceRoot: root, bareSpecifiers: {} },
        }),
      ).rejects.toThrow(/build-time macros/)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(marker, { force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  test('inert import attributes inside the workspace still bundle', async () => {
    const root = await workspace({
      'server/index.ts':
        "import data from './data.json' with { type: 'json' }\nexport function activate() { return data.answer }",
      'server/data.json': '{ "answer": 42 }',
    })
    try {
      const result = await buildPluginPackage({
        sourceDir: root,
        outputDir: join(root, '.dist'),
        manifest: MANIFEST,
        resolve: { workspaceRoot: root, bareSpecifiers: {} },
      })
      expect(result.files).toContain('server/index.js')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the macro scan is fail-closed against every spelling of the clause', () => {
    const rejected = [
      "import { x } from './m.ts' with { type: 'macro' }",
      'import { x } from "./m.ts" with {type:"macro"}',
      "import { x } from './m.ts' assert { type: 'macro' }",
      "import { x } from './m.ts' with /* hidden */ { type: 'macro' }",
      "import { x } from './m.ts' with { 'type': 'macro' }",
      "import { x } from './m.ts' with { type: 'macro' /* } */ }",
      "import { x } from './m.ts' with { type: 'json', extra: 1 }",
      "const m = await import('./m.ts', { with: { type: 'macro' } })",
      "import { x } from './m.ts' with { \\u0074ype: 'macro' }",
    ]
    for (const source of rejected) {
      expect(() => assertNoBuildTimeMacros(source, 'index.ts')).toThrow(/not allowed/)
    }
    const accepted = [
      "import data from './d.json' with { type: 'json' }",
      'import text from "./t.txt" with { "type": "text" }',
      "import cfg from './c.toml' assert { type: 'toml' }",
      "import { pwn } from './m.ts'\nexport const withBraces = { with: 1 }",
    ]
    for (const source of accepted) {
      expect(() => assertNoBuildTimeMacros(source, 'index.ts')).not.toThrow()
    }
  })

  test('unlisted bare specifier fails; mapped one resolves to the host SDK', async () => {
    const rejected = await workspace({
      'server/index.ts': "import { html } from '@instatic/plugin-sdk'\nexport function activate() { return html }",
    })
    try {
      await expect(
        buildPluginPackage({
          sourceDir: rejected,
          outputDir: join(rejected, '.dist'),
          manifest: MANIFEST,
          resolve: { workspaceRoot: rejected, bareSpecifiers: {} },
        }),
      ).rejects.toThrow(/not an allowed dependency/)
    } finally {
      await rm(rejected, { recursive: true, force: true })
    }

    const mapped = await workspace({
      'server/index.ts': "import { html } from '@instatic/plugin-sdk'\nexport function activate() { return String(html) }",
    })
    try {
      const result = await buildPluginPackage({
        sourceDir: mapped,
        outputDir: join(mapped, '.dist'),
        manifest: MANIFEST,
        resolve: {
          workspaceRoot: mapped,
          bareSpecifiers: { '@instatic/plugin-sdk': SDK_ENTRY },
        },
      })
      expect(result.files).toContain('server/index.js')
    } finally {
      await rm(mapped, { recursive: true, force: true })
    }
  })
})
