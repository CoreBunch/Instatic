/**
 * `SiteFileType: 'plugin'` isolation gate.
 *
 * Site plugin source files live in the site draft but must NEVER reach any
 * visitor/module surface: published script bundles, user stylesheets,
 * `props._siteScripts`, module-readable file lists — or the site editor's
 * explorer (they are edited exclusively in the Plugin IDE). The pipelines
 * select by EXACT type (`type === 'script'` / `type === 'style'`), so
 * 'plugin' files are excluded by NOT matching; this gate pins that.
 */
import { describe, expect, test } from 'bun:test'
import { collectAppliedStyles, collectRuntimeScripts, DEFAULT_SITE_RUNTIME } from '@core/site-runtime'
import { reconcileSiteExplorerOrganization } from '@core/page-tree'
import type { SiteFile } from '@core/files/schemas'

const file = (id: string, path: string, type: SiteFile['type'], content = 'export {}'): SiteFile => ({
  id,
  path,
  type,
  content,
  createdAt: 1,
  updatedAt: 1,
})

const page = { id: 'page-1' }

describe('site plugin file isolation', () => {
  test("'plugin' files never become runtime scripts", () => {
    const files = [
      file('f1', 'plugins/newsletter/server/index.ts', 'plugin'),
      file('f2', 'src/scripts/fx.ts', 'script'),
    ]
    const collected = collectRuntimeScripts({
      files,
      runtime: DEFAULT_SITE_RUNTIME,
      page,
      target: 'published',
    })
    expect(collected.map((entry) => entry.file.id)).toEqual(['f2'])
  })

  test("'plugin' files never become user stylesheets", () => {
    const files = [
      file('f1', 'plugins/newsletter/frontend/styles.css', 'plugin', 'body { color: red }'),
      file('f2', 'src/styles/site.css', 'style', 'body { margin: 0 }'),
    ]
    const collected = collectAppliedStyles({
      files,
      runtime: DEFAULT_SITE_RUNTIME,
      page,
    })
    expect(collected.map((entry) => entry.file.id)).toEqual(['f2'])
  })

  test("site explorer reconciliation drops 'plugin' files from the scripts section", () => {
    const files = [
      file('f1', 'plugins/demo/server/index.ts', 'plugin'),
      file('f2', 'src/scripts/fx.ts', 'script'),
    ]
    // Reconciliation keeps rowOrder entries only for rows the section still
    // derives from `files` — a 'plugin' file must never be a scripts row.
    const organization = reconcileSiteExplorerOrganization(
      {
        pages: { expandedFolders: [], emptyFolders: [], rowOrder: [] },
        styles: { expandedFolders: [], emptyFolders: [], rowOrder: [] },
        scripts: {
          expandedFolders: [],
          emptyFolders: [],
          rowOrder: [
            { kind: 'item', id: 'f1', parentPath: 'plugins/demo/server', order: 0 },
            { kind: 'item', id: 'f2', parentPath: 'src/scripts', order: 1 },
          ],
        },
        templates: { folders: [], items: [] },
        components: { folders: [], items: [] },
      },
      { pages: [], visualComponents: [], files },
    )
    const scriptRowIds = organization.scripts.rowOrder.map((row) => row.id)
    expect(scriptRowIds).toContain('f2')
    expect(scriptRowIds).not.toContain('f1')
  })

  test("no published-output pipeline matches 'plugin' by type", async () => {
    // Static gate: the string  type === 'plugin'  must not appear in any
    // published-output pipeline — 'plugin' files are excluded by NOT
    // matching, never included by matching.
    const glob = new Bun.Glob('{server/publish,src/core/publisher,src/core/site-runtime}/**/*.ts')
    for await (const path of glob.scan('.')) {
      const text = await Bun.file(path).text()
      expect(text.includes("type === 'plugin'"), `${path} matches 'plugin' file type`).toBe(false)
    }
  })
})
