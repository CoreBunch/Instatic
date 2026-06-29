/**
 * Architecture gate: page-tree mutations must reach the engine through the
 * canonical `applyTreeOperation` barrel export, NOT by deep-importing
 * `mutations.ts` directly.
 *
 * The visual editor reaches the 11 named mutations via `mutateActiveTree`;
 * headless callers (the plugin `cms.content.tree.*` RPC and the MCP server)
 * reach them via the shared, actor-agnostic page-tree service
 * (`server/ai/content/treeService.ts`), which dispatches through
 * `applyTreeOperation`. Both paths go through the same dispatcher so they
 * ride the same gates the editor does (locked nodes, container-only
 * invariants, breakpoint-override rules).
 *
 * Mirrors the spirit of `no-vc-mode-branches-in-mutations.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

const TREE_SERVICE = 'server/ai/content/treeService.ts'
const PLUGIN_HANDLER = 'server/plugins/host/handlers/content.ts'

describe('page-tree mutation — via engine', () => {
  it('treeService.ts imports applyTreeOperation from the @core/page-tree barrel', async () => {
    const source = await read(TREE_SERVICE)
    expect(source).toMatch(/from '@core\/page-tree'/)
    expect(source).toContain('applyTreeOperation')
  })

  it('treeService.ts dispatches each op through applyTreeOperation', async () => {
    const source = await read(TREE_SERVICE)
    // grep for the call site so future refactors that bypass the engine
    // (e.g. an inline per-op `kind` switch) fail this gate.
    expect(source).toContain('applyTreeOperation(tree')
  })

  it('neither the service nor the plugin handler deep-imports mutations.ts', async () => {
    for (const rel of [TREE_SERVICE, PLUGIN_HANDLER]) {
      const source = await read(rel)
      expect(source).not.toMatch(/from ['"][^'"]*page-tree\/mutations['"]/)
    }
  })

  it('the plugin tree handlers delegate to the shared engine service', async () => {
    const source = await read(PLUGIN_HANDLER)
    // The handler must route through the shared service rather than reaching
    // for the engine (or a hand-rolled per-op switch) on its own.
    expect(source).toContain('mutatePageTree')
    expect(source).toMatch(/from ['"][^'"]*ai\/content\/treeService['"]/)
  })
})
