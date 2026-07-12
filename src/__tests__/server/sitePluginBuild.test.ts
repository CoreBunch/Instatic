/**
 * Server-side site plugin build — materialized workspace, shared builder
 * core with import containment, validate-only mode, single-flight queue.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSitePlugin } from '../../../server/plugins/sitePlugins/build'
import type { SiteFile } from '@core/files/schemas'

const file = (path: string, content: string): SiteFile => ({
  id: path,
  path,
  type: 'plugin',
  content,
  createdAt: 1,
  updatedAt: 1,
})

const routesManifest = JSON.stringify({ name: 'Newsletter', permissions: ['cms.routes'] })

const serverEntry = [
  `export function activate(api) {`,
  `  api.cms.routes.get('/status', 'plugins.read', () => ({ ok: true }))`,
  `}`,
].join('\n')

describe('buildSitePlugin', () => {
  test('happy path writes plugin.json + server bundle under uploads', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'uploads-'))
    try {
      const result = await buildSitePlugin({
        localId: 'newsletter',
        files: [
          file('plugins/newsletter/plugin.json', routesManifest),
          file('plugins/newsletter/server/index.ts', serverEntry),
        ],
        previousVersion: null,
        uploadsDir,
        validateOnly: false,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.manifest.id).toBe('site.newsletter')
      expect(result.manifest.version).toBe(`1.0.1+${result.contentHash}`)
      expect(result.packageDir).toBe(
        join(uploadsDir, 'plugins', 'site.newsletter', result.manifest.version),
      )
      expect(existsSync(join(result.packageDir!, 'plugin.json'))).toBe(true)
      expect(existsSync(join(result.packageDir!, 'server/index.js'))).toBe(true)
      const bundle = await Bun.file(join(result.packageDir!, 'server/index.js')).text()
      expect(bundle).toContain('__plugin_exports')
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('validate-only leaves uploads untouched and returns the modules bundle', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'uploads-'))
    try {
      const result = await buildSitePlugin({
        localId: 'kit',
        files: [
          file('plugins/kit/plugin.json', JSON.stringify({ name: 'Kit', permissions: ['modules.register'] })),
          file(
            'plugins/kit/modules/card.ts',
            [
              `import { control, defineModule, html } from '@instatic/plugin-sdk'`,
              `export default defineModule({`,
              `  id: 'site.kit.card', name: 'Card', htmlTag: 'div',`,
              `  defaults: { text: 'hi' },`,
              `  schema: { text: control.text('Text') },`,
              `  render: ({ props }) => ({ html: html\`<div>\${props.text}</div>\` }),`,
              `})`,
            ].join('\n'),
          ),
        ],
        previousVersion: null,
        uploadsDir,
        validateOnly: true,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.packageDir).toBeUndefined()
      expect(result.modulesBundle).toContain('site.kit.card')
      expect(await readdir(uploadsDir)).toEqual([])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('containment violation surfaces as a diagnostic', async () => {
    const result = await buildSitePlugin({
      localId: 'evil',
      files: [
        file('plugins/evil/plugin.json', JSON.stringify({ name: 'Evil', permissions: ['cms.routes'] })),
        file('plugins/evil/server/index.ts', "import x from '../../../.env' with { type: 'text' }\nexport function activate() { return x }"),
      ],
      previousVersion: null,
      validateOnly: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.join('\n')).toMatch(/outside the plugin workspace/)
  })

  test('forbidden node primitives surface as a diagnostic', async () => {
    const result = await buildSitePlugin({
      localId: 'nodey',
      files: [
        file('plugins/nodey/plugin.json', JSON.stringify({ name: 'Nodey', permissions: ['cms.routes'] })),
        file('plugins/nodey/server/index.ts', "import { readFileSync } from 'node:fs'\nexport function activate() { return readFileSync('/etc/passwd') }"),
      ],
      previousVersion: null,
      validateOnly: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.join('\n')).toMatch(/node:|not an allowed dependency|sandbox/i)
  })

  test('missing plugin.json is a diagnostic, not a crash', async () => {
    const result = await buildSitePlugin({
      localId: 'ghost',
      files: [file('plugins/ghost/server/index.ts', serverEntry)],
      previousVersion: null,
      validateOnly: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics[0]).toContain('plugin.json is missing')
  })

  test('builds are single-flight per localId', async () => {
    const files = [
      file('plugins/serial/plugin.json', routesManifest),
      file('plugins/serial/server/index.ts', serverEntry),
    ]
    const [a, b] = await Promise.all([
      buildSitePlugin({ localId: 'serial', files, previousVersion: null, validateOnly: true }),
      buildSitePlugin({ localId: 'serial', files, previousVersion: null, validateOnly: true }),
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
  })
})
