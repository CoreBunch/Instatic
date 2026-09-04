/**
 * `instatic-plugin lint` — unit tests for the lint pipeline.
 *
 * Builds throwaway plugin source trees in a temp directory, then asserts
 * that `lintPlugin(dir)` reports the expected findings. Tests cover:
 *  • Missing or malformed `instatic-plugin.config.ts` is surfaced cleanly
 *  • `network.outbound` permission without `networkAllowedHosts` is an error
 *  • `networkAllowedHosts` without `network.outbound` is a warning
 *  • `cms.content.*` permissions without a matching `contentAccess` mode
 *    entry are a warning; the missing-allowlist case stays a single error
 *  • Source files with `'node:*'` / `'bun:*'` / `require(` are errors
 *  • Bundled `dist/` outputs that smuggle forbidden literals are errors
 *  • A clean plugin reports zero findings
 *  • The CLI's own content-editor scaffold builds a manifest that carries
 *    `contentAccess` through `definePlugin` and lints clean
 */
import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lintPlugin } from '../../core/plugin-sdk/cli/lint'
import { runPluginInit } from '../../core/plugin-sdk/cli/init'
import { readPluginDefinition } from '../../core/plugin-sdk/cli/build'

const PROJECT_ROOT = join(import.meta.dir, '../../..')

/**
 * Plugin source trees must live INSIDE the monorepo so the dynamic `import`
 * of `instatic-plugin.config.ts` can resolve `@core/plugin-sdk` via the host's
 * tsconfig paths. Lint-test temp dirs land under `.tmp-lint/` next to the
 * other dev temp dirs.
 */
async function withTempPlugin(setup: (dir: string) => Promise<void>) {
  const parentDir = join(PROJECT_ROOT, '.tmp-lint')
  await mkdir(parentDir, { recursive: true })
  const dir = await mkdtemp(join(parentDir, 'plugin-'))
  try {
    await setup(dir)
    return await lintPlugin(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Helper: write a minimal `instatic-plugin.config.ts` so the lint reaches the
 * checks under test. The SDK import resolves via the host's tsconfig paths
 * because the lint process is run by `bun test` inside the monorepo.
 */
function writeConfig(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const config = {
    id: 'acme.lint',
    name: 'Lint Test',
    version: '1.0.0',
    apiVersion: 1,
    permissions: [] as string[],
    ...overrides,
  }
  return writeFile(
    join(dir, 'instatic-plugin.config.ts'),
    `import { definePlugin } from '@core/plugin-sdk'\nexport default definePlugin(${JSON.stringify(config, null, 2)})\n`,
    'utf-8',
  )
}

describe('instatic-plugin lint', () => {
  it('reports a clean plugin with zero findings', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir)
    })
    expect(result.findings).toEqual([])
    expect(result.pluginId).toBe('acme.lint')
  })

  it('errors when `network.outbound` is requested without an allowlist', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { permissions: ['network.outbound'] })
    })
    const findings = result.findings.filter((f) => f.severity === 'error')
    expect(findings).toHaveLength(1)
    expect(findings[0].scope).toBe('manifest')
    expect(findings[0].message).toContain('networkAllowedHosts')
  })

  it('warns when `networkAllowedHosts` is set without the permission', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { networkAllowedHosts: ['api.example.com'] })
    })
    const findings = result.findings.filter((f) => f.severity === 'warning')
    expect(findings).toHaveLength(1)
    expect(findings[0].scope).toBe('manifest')
    expect(findings[0].message).toContain('network.outbound')
  })

  it('warns when a cms.content.* permission has no contentAccess entry declaring its mode', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, {
        permissions: ['cms.content.read', 'cms.content.delete'],
        contentAccess: [{ table: 'posts', modes: ['read'] }],
      })
    })
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([])
    const warnings = result.findings.filter((f) => f.severity === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].scope).toBe('manifest')
    expect(warnings[0].message).toContain('cms.content.delete')
    expect(warnings[0].message).toContain('"delete"')
  })

  it('does not warn when every cms.content.* permission is covered by a contentAccess mode', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, {
        permissions: ['cms.content.read', 'cms.content.write'],
        contentAccess: [{ table: 'pages', modes: ['read', 'write'] }],
      })
    })
    expect(result.findings).toEqual([])
  })

  it('keeps the missing-contentAccess case a single manifest error (no duplicate warnings)', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { permissions: ['cms.content.read'] })
    })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].severity).toBe('error')
    expect(result.findings[0].scope).toBe('manifest')
    expect(result.findings[0].message).toContain('contentAccess')
  })

  it('errors on forbidden literals in server source files', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir)
      await mkdir(join(dir, 'server'), { recursive: true })
      await writeFile(
        join(dir, 'server', 'index.ts'),
        `import { readFile } from 'node:fs/promises'\nexport function activate(api) { void readFile }\n`,
        'utf-8',
      )
    })
    const offenders = result.findings.filter((f) => f.scope === 'source:server')
    // The literal `'node:` appears in the source as part of `'node:fs/promises'`.
    // Either both quote variants tripped is fine — what matters is at least
    // one error is reported with the right scope and file pointer.
    expect(offenders.length).toBeGreaterThan(0)
    expect(offenders[0].severity).toBe('error')
    expect(offenders[0].file).toContain('server/index.ts')
  })

  it('errors on forbidden literals in a bundled dist artifact', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir)
      await mkdir(join(dir, 'dist', 'server'), { recursive: true })
      await writeFile(
        join(dir, 'dist', 'server', 'index.js'),
        `;(() => { /* clean source but the bundle smuggled */ var x = require('whatever') })();`,
        'utf-8',
      )
    })
    const offenders = result.findings.filter((f) => f.scope === 'bundle:server')
    expect(offenders.length).toBe(1)
    expect(offenders[0].severity).toBe('error')
    expect(offenders[0].message).toContain('require(')
  })

  it('errors when an editor source exists without the editor.code permission', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir)
      await mkdir(join(dir, 'editor'), { recursive: true })
      await writeFile(
        join(dir, 'editor', 'index.ts'),
        `export function activate() {}\n`,
        'utf-8',
      )
    })
    const offenders = result.findings.filter((f) => f.severity === 'error')
    expect(offenders).toHaveLength(1)
    expect(offenders[0].scope).toBe('manifest')
    expect(offenders[0].message).toContain('editor.code')
  })

  it('does not flag an editor source when editor.code is requested', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { permissions: ['editor.code'] })
      await mkdir(join(dir, 'editor'), { recursive: true })
      await writeFile(
        join(dir, 'editor', 'index.ts'),
        `export function activate() {}\n`,
        'utf-8',
      )
    })
    expect(result.findings).toEqual([])
  })

  it('reports a config-level error when instatic-plugin.config.ts is missing', async () => {
    const result = await withTempPlugin(async () => {
      // Intentionally do not write any config file.
    })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].severity).toBe('error')
    expect(result.findings[0].scope).toBe('config')
    expect(result.pluginId).toBe('<unknown>')
  })

  it('content-editor scaffold carries contentAccess into the manifest and lints clean', async () => {
    // Regression: `definePlugin` used to drop `contentAccess` from the
    // manifest it returned, so the CLI's own content-editor scaffold failed
    // this very lint with "contentAccess is required when any cms.content.*
    // permission is granted" — and installed plugins failed closed on every
    // cms.content.* call despite the operator's grant.
    const parentDir = join(PROJECT_ROOT, '.tmp-lint')
    await mkdir(parentDir, { recursive: true })
    const dir = await mkdtemp(join(parentDir, 'scaffold-'))
    try {
      const pluginDir = await runPluginInit('acme.content-lint', {
        kind: 'content-editor',
        parentDir: dir,
      })

      const definition = await readPluginDefinition(pluginDir)
      expect(definition.manifest.contentAccess).toEqual([
        { table: 'pages', modes: ['read', 'write'] },
      ])

      const result = await lintPlugin(pluginDir)
      expect(result.findings).toEqual([])
      expect(result.pluginId).toBe('acme.content-lint')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
