/**
 * Site plugin invariants — the contracts no unit test above owns
 * (design: docs/plans/2026-07-02-site-local-integrations-design.md;
 * feature: docs/features/site-plugins.md).
 *
 * The load-bearing simplification: a site plugin IS an installed plugin at
 * runtime. Provenance ('site-local') exists for display + lifecycle
 * routing only — the worker, VM, host bridges, and publish machinery must
 * never branch on it.
 */
import { describe, expect, test } from 'bun:test'

describe('site plugin invariants', () => {
  test("the runtime has zero 'site-local' branches", async () => {
    // The string 'site-local' may appear ONLY in: the repository (row
    // plumbing), the site plugin engine/handlers, the install seam, the
    // SDK's provenance type, and UI presentation.
    const allowed = [
      /server\/repositories\/plugins\.ts$/,
      /server\/plugins\/sitePlugins\//,
      /server\/handlers\/cms\/sitePlugins\.ts$/,
      /server\/handlers\/cms\/plugins\/install\.ts$/,
      /server\/db\/migrations-(pg|sqlite)\.ts$/, // the source-column migration comment/default
      /src\/core\/plugin-sdk\/types\/installedPlugin\.ts$/,
      /src\/core\/site-plugins\//,
      /src\/admin\/pages\/plugins\//,
    ]
    const glob = new Bun.Glob('{server,src}/**/*.{ts,tsx}')
    const offenders: string[] = []
    for await (const path of glob.scan('.')) {
      if (path.includes('__tests__')) continue
      const text = await Bun.file(path).text()
      if (!text.includes("'site-local'")) continue
      if (allowed.some((pattern) => pattern.test(path))) continue
      offenders.push(path)
    }
    expect(offenders).toEqual([])
  })

  test('worker / VM / host-bridge plugin machinery never mentions site plugins', async () => {
    const glob = new Bun.Glob('server/plugins/{quickjs,host,protocol}/**/*.ts')
    for await (const path of glob.scan('.')) {
      const text = await Bun.file(path).text()
      expect(text.includes('sitePlugin'), `${path} references sitePlugin`).toBe(false)
      expect(text.includes("'site-local'"), `${path} branches on 'site-local'`).toBe(false)
    }
  })

  test('the zip-install boundary rejects the reserved namespace (source pin)', async () => {
    const text = await Bun.file('server/plugins/package.ts').text()
    expect(text).toContain('isReservedSitePluginId')
  })

  test('site plugin builds always pass an import-containment policy', async () => {
    // The server build orchestrator must never call buildPluginPackage
    // without `resolve:` — dropping it would let draft imports read host
    // files. Pin the call shape.
    const text = await Bun.file('server/plugins/sitePlugins/build.ts').text()
    expect(text).toContain('buildPluginPackage')
    expect(text).toContain('workspaceRoot: workspace.rootDir')
    expect(text).toContain("'@instatic/plugin-sdk': SDK_ENTRY")
  })

  test('activation authority stays with plugins.install + conditional step-up', async () => {
    const text = await Bun.file('server/handlers/cms/sitePlugins.ts').text()
    // Activate + rollback gate on plugins.install…
    expect(text.match(/requireCapability\(req, db, 'plugins\.install'\)/g)?.length).toBeGreaterThanOrEqual(2)
    // …and step-up runs behind the grant-diff, not unconditionally.
    expect(text).toContain('grantsChanged')
    expect(text).toContain('requireStepUp')
  })
})
