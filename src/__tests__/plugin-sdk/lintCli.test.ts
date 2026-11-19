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

  it('errors when appScopes are declared without the members.read permission', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, {
        permissions: ['cms.routes'],
        appScopes: [{ name: 'read', description: 'See your purchases' }],
      })
    })
    const errors = result.findings.filter((f) => f.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].scope).toBe('manifest')
    expect(errors[0].message).toContain('members.read')
  })

  it('errors when a route opens itself to apps under a scope appScopes does not declare', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, {
        permissions: ['cms.routes', 'members.read'],
        appScopes: [{ name: 'read', description: 'See your purchases' }],
      })
      await mkdir(join(dir, 'server'), { recursive: true })
      await writeFile(
        join(dir, 'server', 'index.ts'),
        `export function activate(api) {
          api.cms.routes.member.get('/orders', { app: { scope: 'read' } }, () => ({}))
          api.cms.routes.member.post('/licenses', { tag: 'pro', app: { scope: "manage" } }, () => ({}))
        }\n`,
        'utf-8',
      )
    })
    const errors = result.findings.filter((f) => f.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].scope).toBe('source:server')
    expect(errors[0].file).toBe('server/index.ts')
    expect(errors[0].message).toContain('"manage"')
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

  it('carries frontend.origins through definePlugin and does not look for an external script on disk', async () => {
    let origins: unknown
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, {
        permissions: ['frontend.assets'],
        frontend: {
          assets: [{ kind: 'script', src: 'https://js.example.com/v3' }],
          origins: { scripts: ['js.example.com'], frames: ['pay.example.com'] },
        },
      })
      origins = (await readPluginDefinition(dir)).manifest.frontend?.origins
    })
    expect(result.findings).toEqual([])
    expect(origins).toEqual({ scripts: ['js.example.com'], frames: ['pay.example.com'] })
  })

  it('accepts the frontend.assets permission when only origins are declared', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, {
        permissions: ['frontend.assets'],
        frontend: { assets: [], origins: { frames: ['pay.example.com'] } },
      })
    })
    expect(result.findings).toEqual([])
  })

  it('reports an external script on an undeclared host', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, {
        permissions: ['frontend.assets'],
        frontend: {
          assets: [{ kind: 'script', src: 'https://evil.example.net/x.js' }],
          origins: { scripts: ['js.example.com'] },
        },
      })
    })
    const errors = result.findings.filter((f) => f.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('frontend.origins.scripts')
  })

  const WELCOME = {
    key: 'welcome',
    label: 'Welcome',
    description: 'Sent after sign-up.',
    variables: [{ name: 'link', label: 'Link', sample: 'https://example.com/start', kind: 'link' }],
    subject: 'Welcome to {site.name}',
    body: '[Start]({link})',
  }

  it('carries mail.templates through definePlugin and lints a complete declaration clean', async () => {
    const result = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { permissions: ['mail.send'], mail: { templates: [WELCOME] } })
      const definition = await readPluginDefinition(dir)
      expect(definition.manifest.mail?.templates[0]).toMatchObject({ key: 'welcome', subject: 'Welcome to {site.name}' })
    })
    expect(result.findings).toEqual([])
  })

  it('refuses a mail template that uses a variable it does not declare, or glues a link into text', async () => {
    const lint = (template: Record<string, unknown>) =>
      withTempPlugin(async (dir) => {
        await writeConfig(dir, { permissions: ['mail.send'], mail: { templates: [{ ...WELCOME, ...template }] } })
      })
    const undeclared = await lint({ body: 'Hello {memebr.name}, [start]({link})' })
    expect(undeclared.findings).toHaveLength(1)
    expect(undeclared.findings[0]).toMatchObject({ severity: 'error' })
    expect(undeclared.findings[0].message).toContain('{memebr.name}')

    // Rendered here exactly as the server will render it: the link would be sent unfilled.
    for (const body of ['Start here:{link}', 'See example.com/go?to={link}', '<{link}>']) {
      const glued = await lint({ body })
      expect(glued.findings.map((finding) => finding.severity)).toEqual(['error'])
      expect(glued.findings[0].message).toContain('{link} must stand alone')
    }
    // A link's sample must be a link, and a text sample must not be one.
    const badSample = await lint({ variables: [{ name: 'link', label: 'Link', sample: 'https://example.com/start' }] })
    expect(badSample.findings[0].message).toContain('contains a web address')
  })

  it('warns about a mail permission with nothing to send, and refuses templates without one', async () => {
    const unused = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { permissions: ['mail.send.external'] })
    })
    expect(unused.findings.map((f) => f.severity)).toEqual(['warning'])
    expect(unused.findings[0].message).toContain('mail.templates[]')

    const unpermitted = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { permissions: [], mail: { templates: [WELCOME] } })
    })
    expect(unpermitted.findings.some((f) => f.severity === 'error' && f.message.includes('mail.send'))).toBe(true)
  })

  it('carries a resource uniqueField through definePlugin and refuses one that is not a declared text field', async () => {
    const resource = (uniqueField: string) => ({
      id: 'events',
      title: 'Events',
      uniqueField,
      fields: [
        { id: 'eventId', label: 'Event id', type: 'text' },
        { id: 'amount', label: 'Amount', type: 'number' },
      ],
    })
    const clean = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { permissions: ['cms.storage'], resources: [resource('eventId')] })
    })
    expect(clean.findings).toEqual([])

    const missing = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { permissions: ['cms.storage'], resources: [resource('nope')] })
    })
    expect(missing.findings.some((f) => f.severity === 'error' && f.message.includes('declares no field with that id'))).toBe(true)

    const wrongType = await withTempPlugin(async (dir) => {
      await writeConfig(dir, { permissions: ['cms.storage'], resources: [resource('amount')] })
    })
    expect(wrongType.findings.some((f) => f.severity === 'error' && f.message.includes('must be a "text" field'))).toBe(true)
  })
})
