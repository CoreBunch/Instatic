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
import { buildPluginPackage } from '@core/plugin-build'
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
