# Module JS Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modules can ship a small vanilla-JS runtime with published pages: `render()` gains `js?: string`, deduped per moduleId like CSS, served as per-module external assets at `/_instatic/module-js/<moduleId>.js`, injected only on pages that need them — with the hand-special-cased form runtime migrated onto the channel as its first consumer.

**Architecture:** `RenderAccumulators` gains a `jsMap` populated by `renderNode` exactly like `cssMap`; `publishPage` reports per-page candidates (render-emitted moduleIds ∪ static hole-subtree moduleIds); the server intersects candidates with a site-wide module-JS map (memoised per `publishVersion`, `buildPublishedSiteCssBundle` pattern) and a new `injectModuleScripts` pipeline step appends sorted `<script defer>` tags + relaxes CSP. The old `/_instatic/form-runtime.js` route, `injectFormRuntime`, and regex form detection are deleted; `stampFormPageTokens` survives as its own pipeline step and is additionally applied to hole fragments. Plugin module `js` crosses the QuickJS boundary string-typed and is dropped host-side unless the plugin's `grantedPermissions` include `frontend.assets`.

**Tech Stack:** Bun (test/build/lint), TypeScript, TypeBox at boundaries, QuickJS-WASM plugin sandbox with committed bootstrap artifacts (`bun run bootstrap:sync`).

**Base commit:** `0503316e` (fresh worktree off main). All line refs verified against this commit.

---

## File Structure

**Create:**
- `docs/superpowers/specs/2026-06-10-module-js-channel-design.md` — approved spec, copied into the repo.
- `src/core/publisher/holeSubtreeModules.ts` — `collectHoleSubtreeModuleIds(page, site, dynamicNodeIds)`: static moduleId census of hole subtrees (children + VC trees, cycle-guarded).
- `server/publish/siteModuleAssets.ts` — `collectSiteModuleAssets(site, registry)`: the one full-site render walk shared by the CSS framework bundle and the module-JS map.
- `server/publish/moduleJsBundle.ts` — `buildSiteModuleJsMap`, `buildPublishedSiteModuleJsMap` (version+site memo), pure `injectModuleScripts(html, ids, version)`.
- `server/handlers/cms/moduleJs.ts` — `isModuleJsAssetPath`, `handleModuleJsAssetRequest` (versioned single-flight snapshot → map; validates untrusted moduleId; 404/405; `text/javascript`; `max-age=3600`).
- `src/modules/base/forms/formRuntimeJs.ts` — `FORM_RUNTIME_JS` browser IIFE (document-level delegation, per-form `data-instatic-page-id`).
- Tests: `src/__tests__/publisher/moduleJsCollection.test.ts`, `src/__tests__/publisher/moduleJsPage.test.ts`, `src/__tests__/publisher/formModuleJs.test.ts`, `src/__tests__/server/moduleJsBundle.test.ts`, `src/__tests__/server/moduleJsRoute.test.ts`, `src/__tests__/architecture/module-js-asset-route.test.ts`.

**Modify:**
- `src/core/module-engine/types.ts:51-59` — `RenderOutput` gains `js?: string`.
- `src/core/publisher/renderConfig.ts:132-155` — `RenderAccumulators` gains `jsMap`.
- `src/core/publisher/renderNode.ts:166-181` — collect `output.js` into `acc.jsMap`.
- `src/core/publisher/render.ts:70-75, 485-563` — `PublishedPage` gains `jsModuleIds`; `publishPage` computes it.
- `src/core/publisher/index.ts` — export `collectHoleSubtreeModuleIds`.
- Accumulator construction sites: `src/admin/pages/site/agent/executor.ts:361`, `server/ai/tools/site/render.ts:310`, `server/handlers/cms/loop.ts:152`, `server/handlers/cms/hole.ts:173-178`, `server/publish/siteCssBundle.ts:169-188`, `src/__tests__/publisher/helpers.ts:20-26`.
- `server/publish/publicRenderer.ts:36-42, 66-113, 115-137` — `RendererOutput` gains `jsModuleIds` + `publishVersion`; `renderMergedTemplate` filters candidates against the site map.
- `server/publish/publishedHtmlPipeline.ts:29-59` — replace `injectFormRuntime` with `stampFormPageTokens` + `injectModuleScripts`.
- `server/handlers/cms/data/preview.ts:110-140` — thread the new `RendererOutput` fields.
- `server/forms/formRuntime.ts` — keep only `stampFormPageTokens` (now also stamps `data-instatic-page-id`); DELETE `FORM_RUNTIME_JS`, `FORM_RUNTIME_PATH`, `injectFormRuntime`, `pageHasCmsNativeForm`, `serveFormRuntimeAsset`, `relaxScriptCsp`.
- `server/router.ts:12, 61-83, 171-174` — add `tryServeModuleJsAsset`; DELETE `tryServePublicFormRuntimeAsset` + its import.
- `src/modules/base/forms/index.ts:193-208` — `base.form` render emits `js: FORM_RUNTIME_JS` when `mode === 'cms'`.
- `src/core/plugin-sdk/modules.ts:46-49` — `PluginRenderOutput` gains `js?: string`.
- `server/plugins/modulePackVm.ts:50-53, 81-87` — `ModulePackRenderOutput` gains `js?: string`.
- `server/plugins/quickjs/bootstrap/src/modulePackRuntime.ts:28-35` — `normalizeRenderOutput` passes `js` through string-typed (then `bun run bootstrap:sync`).
- `src/core/plugins/moduleAdapter.ts:119-181` — `pluginModuleToHostModule` gains required `grantedPermissions` param; gates `js` on `frontend.assets`, warns once per module.
- `src/core/plugins/modulePackLoader.ts:80-97, 162-216` — thread `manifest.grantedPermissions ?? []`; `SandboxedModulePack` render/preview return `js?`.
- Tests: `src/__tests__/publisher/formRuntime.test.ts` (rewritten), `src/__tests__/server/holeRouteHandler.test.ts`, `src/__tests__/plugins/pluginModulePack.test.ts`, `src/__tests__/server/modulePackVm.test.ts`.
- Docs: `docs/features/publisher.md`, `docs/features/modules.md`, `docs/features/plugin-system.md`, `docs/features/cms-native-forms.md`.
- Generated (via `bun run bootstrap:sync`, never by hand): `server/plugins/quickjs/bootstrap/generated/modulePackBootstrap.ts`.

**Shared signatures (single source of truth for all tasks):**
```ts
// core
interface RenderOutput { html: string; css?: string; js?: string }
interface RenderAccumulators { readonly cssMap: Map<string,string>; readonly jsMap: Map<string,string>; readonly infiniteLoopIds: Set<string>; readonly holeNodeIds: Set<string> }
interface PublishedPage { filename: string; html: string; jsModuleIds: string[] }
function collectHoleSubtreeModuleIds(page: Page, site: SiteDocument, dynamicNodeIds: ReadonlySet<string>): Set<string>
// server
function collectSiteModuleAssets(site: SiteDocument, registry: IModuleRegistry): RenderAccumulators
function buildSiteModuleJsMap(site: SiteDocument, registry: IModuleRegistry): ReadonlyMap<string,string>
function buildPublishedSiteModuleJsMap(site: SiteDocument, registry: IModuleRegistry): ReadonlyMap<string,string>
function injectModuleScripts(html: string, jsModuleIds: readonly string[], publishVersion: number): string
function isModuleJsAssetPath(pathname: string): boolean
function handleModuleJsAssetRequest(req: Request, url: URL, ctx: { db: DbClient }): Promise<Response>
function stampFormPageTokens(html: string, pageId: string): string   // exported, stamps token + page id
interface RendererOutput { html: string; pageId: string; slug: string; siteId: string; jsModuleIds: string[]; publishVersion: number }
// plugins
interface PluginRenderOutput { html: string; css?: string; js?: string }
interface ModulePackRenderOutput { html: string; css?: string; js?: string }
function pluginModuleToHostModule(pluginId: string, definition: PluginModuleDefinition, componentFactory: PluginModuleComponentFactory, grantedPermissions: readonly string[]): ModuleDefinition<Record<string, unknown>>
```

---

### Task 1: Commit the approved spec into the repo

**Files:**
- Create: `docs/superpowers/specs/2026-06-10-module-js-channel-design.md`

- [ ] **Step 1: Copy the spec from /tmp**

Run:
```bash
mkdir -p docs/superpowers/specs
cp /tmp/instatic-specs/2026-06-10-module-js-channel-design.md docs/superpowers/specs/2026-06-10-module-js-channel-design.md
```

- [ ] **Step 2: Verify the copy is intact**

Run: `head -8 docs/superpowers/specs/2026-06-10-module-js-channel-design.md`
Expected: starts with `# Per-module published-JS channel — Design` and `Status: approved (approach 2A: render-emitted JS, per-module external assets)`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-10-module-js-channel-design.md
git commit -m "docs: add module JS channel design spec

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Core contract — `RenderOutput.js` + `jsMap` accumulator + collection in `renderNode`

**Files:**
- Modify: `src/core/module-engine/types.ts:51-59`
- Modify: `src/core/publisher/renderConfig.ts:132-155`
- Modify: `src/core/publisher/renderNode.ts:166-181`
- Modify: `src/core/publisher/render.ts:517-521` (publishPage acc literal)
- Modify: `src/__tests__/publisher/helpers.ts:20-26` (makeAccumulators)
- Modify: `server/publish/siteCssBundle.ts:173-177`, `server/handlers/cms/hole.ts:173-178`, `server/handlers/cms/loop.ts:152`, `server/ai/tools/site/render.ts:310`, `src/admin/pages/site/agent/executor.ts:361` (acc literals)
- Test: `src/__tests__/publisher/moduleJsCollection.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/publisher/moduleJsCollection.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { renderNode } from '@core/publisher'
import type { RenderConfig } from '@core/publisher'
import { makeAccumulators, makeModule, makePage, makeRegistry, makeSite } from './helpers'

describe('renderNode module-JS collection', () => {
  it('collects render() js once per moduleId (deduped like CSS)', () => {
    const registry = makeRegistry({
      'base.body': makeModule('base.body', {
        canHaveChildren: true,
        render: (_p, children) => ({ html: children.join('') }),
      }),
      'test.jsy': makeModule('test.jsy', {
        render: () => ({ html: '<div></div>', js: 'JS_BODY' }),
      }),
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['a', 'b'] },
      a: { moduleId: 'test.jsy' },
      b: { moduleId: 'test.jsy' },
    })
    const site = makeSite({ pages: [page] })
    const config: RenderConfig = { page, site, registry, breakpointId: undefined }
    const acc = makeAccumulators()

    renderNode('root', config, acc)

    expect([...acc.jsMap.entries()]).toEqual([['test.jsy', 'JS_BODY']])
  })

  it('leaves jsMap empty when no module emits js', () => {
    const registry = makeRegistry({
      'test.plain': makeModule('test.plain'),
    })
    const page = makePage({ root: { moduleId: 'test.plain' } })
    const site = makeSite({ pages: [page] })
    const config: RenderConfig = { page, site, registry, breakpointId: undefined }
    const acc = makeAccumulators()

    renderNode('root', config, acc)

    expect(acc.jsMap.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/publisher/moduleJsCollection.test.ts`
Expected: FAIL — TypeScript/runtime error: `jsMap` does not exist on `RenderAccumulators` / `acc.jsMap` is undefined.

- [ ] **Step 3: Add `js` to `RenderOutput`** (`src/core/module-engine/types.ts`, lines 51-59 become)

```ts
export interface RenderOutput {
  /** Clean HTML string — no editor code, no React, no framework runtime */
  html: string
  /**
   * Optional scoped CSS for this module TYPE.
   * The publisher deduplicates across all instances (one CSS block per module type).
   */
  css?: string
  /**
   * Optional vanilla-JS runtime for this module TYPE, deduplicated per
   * moduleId exactly like `css` and served as an external per-module asset
   * (`/_instatic/module-js/<moduleId>.js`) on published pages — never inlined,
   * so no `</script>` escaping is needed. Authoring contract: a self-contained
   * IIFE; bind via document-level event delegation (hole fragments insert into
   * the DOM after load); idempotent; no load-order assumptions; no framework
   * runtimes. Never executed in the admin canvas (the canvas renders editor
   * React components, not published render() output).
   */
  js?: string
}
```

- [ ] **Step 4: Add `jsMap` to `RenderAccumulators`** (`src/core/publisher/renderConfig.ts`, inside the interface after `cssMap` at line 138)

```ts
  /**
   * JS deduplication map: moduleId → module runtime JS. Mirrors `cssMap` —
   * each module type contributes at most one entry regardless of instance
   * count. Served as external per-module files (never inlined), so no
   * `</script>` sanitisation is applied on store.
   */
  readonly jsMap: Map<string, string>
```

- [ ] **Step 5: Collect `js` in `renderStandardNode`** (`src/core/publisher/renderNode.ts`, after the CSS-dedup block at lines 168-173)

```ts
  // JS dedup — one entry per moduleId, mirroring CSS. No escaping needed:
  // module JS is served as an external file (`/_instatic/module-js/<id>.js`),
  // never inlined into the document.
  if (output.js && !acc.jsMap.has(node.moduleId)) {
    acc.jsMap.set(node.moduleId, output.js)
  }
```

- [ ] **Step 6: Add `jsMap: new Map<string, string>(),` to every accumulator literal**

Each of these object literals gains the line `jsMap: new Map<string, string>(),` directly after its `cssMap` line:
- `src/core/publisher/render.ts:517-521` (in `publishPage`)
- `src/__tests__/publisher/helpers.ts:20-26` (`makeAccumulators`)
- `server/publish/siteCssBundle.ts:173-177` (`collectAllModuleCss`)
- `server/handlers/cms/hole.ts:173-178` (`renderHoleFragment`)
- `server/handlers/cms/loop.ts:152`
- `server/ai/tools/site/render.ts:310`
- `src/admin/pages/site/agent/executor.ts:361`

(For the literals written without the generic — `cssMap: new Map(),` — use `jsMap: new Map(),` to match local style.)

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test src/__tests__/publisher/moduleJsCollection.test.ts && bun run build`
Expected: tests PASS; `tsc -b && vite build` clean (the build is the proof every accumulator literal was updated).

- [ ] **Step 8: Commit**

```bash
git add src/core/module-engine/types.ts src/core/publisher/renderConfig.ts src/core/publisher/renderNode.ts src/core/publisher/render.ts src/__tests__/publisher/helpers.ts src/__tests__/publisher/moduleJsCollection.test.ts server/publish/siteCssBundle.ts server/handlers/cms/hole.ts server/handlers/cms/loop.ts server/ai/tools/site/render.ts src/admin/pages/site/agent/executor.ts
git commit -m "feat(publisher): add js channel to RenderOutput and render accumulators

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `publishPage` reports per-page module-JS candidates (render-emitted ∪ hole subtrees)

**Files:**
- Create: `src/core/publisher/holeSubtreeModules.ts`
- Modify: `src/core/publisher/render.ts:70-75` (PublishedPage), `:526` (after `renderNode` call), imports at `:47-54`
- Modify: `src/core/publisher/index.ts` (barrel export)
- Test: `src/__tests__/publisher/moduleJsPage.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/publisher/moduleJsPage.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree'
import { publishPage, collectHoleSubtreeModuleIds } from '@core/publisher'
import { makeModule, makePage, makeRegistry, makeSite } from './helpers'

const registry = makeRegistry({
  'base.body': makeModule('base.body', {
    canHaveChildren: true,
    render: (_p, children) => ({ html: `<main>${children.join('')}</main>` }),
  }),
  'test.jsy': makeModule('test.jsy', {
    render: () => ({ html: '<div></div>', js: 'JS_BODY' }),
  }),
  'test.live': makeModule('test.live', {
    canHaveChildren: true,
    dynamic: true,
    render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
  }),
})

describe('publishPage jsModuleIds', () => {
  it('reports modules that emitted js during the render, sorted', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['a'] },
      a: { moduleId: 'test.jsy' },
    })
    const site = makeSite({ pages: [page] })
    const { jsModuleIds } = publishPage(page, site, registry)
    expect(jsModuleIds).toEqual(['test.jsy'])
  })

  it('includes moduleIds inside hole subtrees even though they never rendered', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['live'] },
      live: { moduleId: 'test.live', children: ['inner'] },
      inner: { moduleId: 'test.jsy' },
    })
    const site = makeSite({ pages: [page] })
    const { html, jsModuleIds } = publishPage(page, site, registry)
    expect(html).toContain('<instatic-hole')
    expect(jsModuleIds).toEqual(['test.jsy', 'test.live'])
  })

  it('reports an empty list for pages with no js and no holes', () => {
    const page = makePage({ root: { moduleId: 'base.body', children: [] } })
    const site = makeSite({ pages: [page] })
    expect(publishPage(page, site, registry).jsModuleIds).toEqual([])
  })
})

describe('collectHoleSubtreeModuleIds', () => {
  it('descends into Visual Component definition trees (cycle-guarded)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref'] },
      ref: { moduleId: 'base.visual-component-ref', props: { componentId: 'vc-1' } },
    })
    const site = makeSite({
      pages: [page],
      visualComponents: [
        {
          id: 'vc-1',
          name: 'Test VC',
          tree: {
            rootNodeId: 'vc-root',
            nodes: {
              'vc-root': {
                id: 'vc-root',
                moduleId: 'test.jsy',
                props: {},
                children: [],
                breakpointOverrides: {},
                classIds: [],
              },
            },
          },
        } as unknown as SiteDocument['visualComponents'][number],
      ],
    })
    const ids = collectHoleSubtreeModuleIds(page, site, new Set(['ref']))
    expect(ids.has('base.visual-component-ref')).toBe(true)
    expect(ids.has('test.jsy')).toBe(true)
  })

  it('returns an empty set when there are no dynamic nodes', () => {
    const page = makePage({ root: { moduleId: 'base.body' } })
    const site = makeSite({ pages: [page] })
    expect(collectHoleSubtreeModuleIds(page, site, new Set()).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/publisher/moduleJsPage.test.ts`
Expected: FAIL — `collectHoleSubtreeModuleIds` is not exported / `jsModuleIds` is undefined.

- [ ] **Step 3: Create `src/core/publisher/holeSubtreeModules.ts`**

```ts
/**
 * Static hole-subtree module census.
 *
 * A `<instatic-hole>` placeholder defers its subtree to request time, so the
 * page render never executes those modules' render() — their `js` cannot land
 * in `RenderAccumulators.jsMap`. This walker statically gathers every moduleId
 * reachable inside the page's hole subtrees (descending through page-tree
 * children AND into referenced Visual Component definition trees,
 * cycle-guarded) so `publishPage` can report them as module-JS candidates.
 *
 * Over-inclusion is deliberate and cheap: the server intersects candidates
 * with the site-wide module-JS map before emitting any `<script>` tag, so a
 * module with no published JS costs nothing. Render-conditional emission
 * (e.g. `base.form` only emits in `cms` mode) cannot be evaluated for an
 * unbaked hole — membership is per-module, per the design spec.
 */
import type { Page, SiteDocument } from '@core/page-tree'
import { selectVisualComponentById } from '@core/page-tree'

/** Structural minimum shared by PageNode and VCNode for this walk. */
interface WalkNode {
  id: string
  moduleId: string
  props: Record<string, unknown>
  children?: string[]
}

export function collectHoleSubtreeModuleIds(
  page: Page,
  site: SiteDocument,
  dynamicNodeIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  if (dynamicNodeIds.size === 0) return out

  const visit = (
    nodes: Record<string, WalkNode>,
    nodeId: string,
    seenVcs: ReadonlySet<string>,
  ): void => {
    const node = nodes[nodeId]
    if (!node) return
    out.add(node.moduleId)
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId =
        typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
      if (componentId && !seenVcs.has(componentId)) {
        const vc = selectVisualComponentById(site, componentId)
        if (vc) {
          visit(
            vc.tree.nodes as Record<string, WalkNode>,
            vc.tree.rootNodeId,
            new Set(seenVcs).add(componentId),
          )
        }
      }
    }
    for (const childId of node.children ?? []) visit(nodes, childId, seenVcs)
  }

  for (const holeNodeId of dynamicNodeIds) {
    visit(page.nodes as Record<string, WalkNode>, holeNodeId, new Set())
  }
  return out
}
```

- [ ] **Step 4: Thread it through `publishPage`** (`src/core/publisher/render.ts`)

Add the import next to the other relative imports (after line 48):
```ts
import { collectHoleSubtreeModuleIds } from './holeSubtreeModules'
```

Extend `PublishedPage` (lines 70-75):
```ts
interface PublishedPage {
  /** Filename for this page in the ZIP archive, e.g. "index.html", "about-us.html" */
  filename: string
  /** Complete <!DOCTYPE html> document — no editor dependencies */
  html: string
  /**
   * Sorted module-JS CANDIDATES for this page: moduleIds that emitted `js`
   * during this render ∪ every moduleId inside this page's hole subtrees.
   * The server intersects this with the site module-JS map before injecting
   * `<script>` tags (see `server/publish/moduleJsBundle.ts`).
   */
  jsModuleIds: string[]
}
```

After `const bodyHtml = renderNode(page.rootNodeId, config, acc)` (line 526), add:
```ts
  // Per-page module-JS candidates: render-emitted ids ∪ static hole-subtree
  // ids. Hole subtrees are NOT rendered here, so the static walk is the only
  // way to know what their request-time fragments will need.
  const jsModuleIds = [
    ...new Set([
      ...acc.jsMap.keys(),
      ...collectHoleSubtreeModuleIds(page, site, dynamicNodeIds),
    ]),
  ].sort()
```

And change the return (lines 559-562) to:
```ts
  return {
    filename: slugToFilename(page.slug, page.title),
    html,
    jsModuleIds,
  }
```

- [ ] **Step 5: Export from the barrel** (`src/core/publisher/index.ts`, after the `renderNode` export at line 11)

```ts
export { collectHoleSubtreeModuleIds } from './holeSubtreeModules'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/__tests__/publisher/moduleJsPage.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/core/publisher/holeSubtreeModules.ts src/core/publisher/render.ts src/core/publisher/index.ts src/__tests__/publisher/moduleJsPage.test.ts
git commit -m "feat(publisher): report per-page module-JS candidates from publishPage

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Server-side site module-JS map + pure script injector

**Files:**
- Create: `server/publish/siteModuleAssets.ts`
- Create: `server/publish/moduleJsBundle.ts`
- Modify: `server/publish/siteCssBundle.ts:149-188` (delete private `collectAllModuleCss`, use shared walker)
- Test: `src/__tests__/server/moduleJsBundle.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/server/moduleJsBundle.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { collectSiteModuleAssets } from '../../../server/publish/siteModuleAssets'
import {
  buildSiteModuleJsMap,
  injectModuleScripts,
} from '../../../server/publish/moduleJsBundle'
import { makeModule, makePage, makeRegistry, makeSite } from '../publisher/helpers'

const registry = makeRegistry({
  'base.body': makeModule('base.body', {
    canHaveChildren: true,
    render: (_p, children) => ({ html: `<main>${children.join('')}</main>` }),
  }),
  'test.jsy': makeModule('test.jsy', {
    render: () => ({ html: '<div></div>', js: 'JS_BODY' }),
  }),
  'test.plain': makeModule('test.plain'),
})

function makeTwoPageSite() {
  const pageA = makePage({
    root: { moduleId: 'base.body', children: ['a'] },
    a: { moduleId: 'test.jsy' },
  })
  const pageB = makePage({
    root: { moduleId: 'base.body', children: ['b'] },
    b: { moduleId: 'test.jsy' },
  })
  pageB.id = 'page-2'
  pageB.slug = 'two'
  return makeSite({ pages: [pageA, pageB] })
}

const HTML_DOC = `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; worker-src 'none'; style-src 'self'; img-src 'self' data:; connect-src 'self';">
</head>
<body>
<main></main>
</body>
</html>`

describe('site module-JS map', () => {
  it('walks every page and dedupes js per moduleId', () => {
    const site = makeTwoPageSite()
    const acc = collectSiteModuleAssets(site, registry)
    expect([...acc.jsMap.entries()]).toEqual([['test.jsy', 'JS_BODY']])
    const map = buildSiteModuleJsMap(site, registry)
    expect([...map.keys()]).toEqual(['test.jsy'])
  })

  it('excludes modules that emit no js', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['p'] },
      p: { moduleId: 'test.plain' },
    })
    const map = buildSiteModuleJsMap(makeSite({ pages: [page] }), registry)
    expect(map.size).toBe(0)
  })
})

describe('injectModuleScripts', () => {
  it('appends sorted, versioned, deferred script tags before </body> and relaxes CSP', () => {
    const html = injectModuleScripts(HTML_DOC, ['z.widget', 'a.widget'], 7)
    const aIdx = html.indexOf('data-instatic-module-js="a.widget"')
    const zIdx = html.indexOf('data-instatic-module-js="z.widget"')
    expect(aIdx).toBeGreaterThan(-1)
    expect(zIdx).toBeGreaterThan(aIdx)
    expect(html).toContain('<script src="/_instatic/module-js/a.widget.js?v=7" defer data-instatic-module-js="a.widget"></script>')
    expect(zIdx).toBeLessThan(html.indexOf('</body>'))
    expect(html).toContain("script-src 'self';")
    expect(html).not.toContain("script-src 'none';")
  })

  it('does nothing (and keeps CSP locked) for an empty id list', () => {
    const html = injectModuleScripts(HTML_DOC, [], 7)
    expect(html).toBe(HTML_DOC)
    expect(html).toContain("script-src 'none';")
  })

  it('is idempotent', () => {
    const once = injectModuleScripts(HTML_DOC, ['a.widget'], 7)
    const twice = injectModuleScripts(once, ['a.widget'], 7)
    expect(twice).toBe(once)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/server/moduleJsBundle.test.ts`
Expected: FAIL — `Cannot find module '../../../server/publish/siteModuleAssets'`.

- [ ] **Step 3: Create `server/publish/siteModuleAssets.ts`**

```ts
/**
 * Site-wide module-asset walk.
 *
 * Walks every page's node tree with the canonical render walker and returns
 * the shared accumulators — `cssMap` feeds the framework CSS bundle
 * (`siteCssBundle.ts`), `jsMap` feeds the published module-JS map
 * (`moduleJsBundle.ts`). One walker, two consumers, so the two channels can
 * never drift on traversal semantics.
 *
 * The HTML produced by `renderNode` is thrown away — discarding it is cheaper
 * than maintaining a separate assets-only walker that would drift from the
 * canonical render path over time. The accumulators are shared across pages,
 * so each module contributes at most one CSS and one JS entry for the whole
 * site even if it appears on every page.
 *
 * Known mirror of the CSS channel's semantics: loop bodies render empty here
 * (no prefetched loop data), so a module that appears ONLY inside loop bodies
 * contributes neither CSS nor JS — pre-existing behaviour, unchanged.
 */
import type { SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import { renderNode } from '@core/publisher'
import type { RenderConfig, RenderAccumulators } from '@core/publisher'

export function collectSiteModuleAssets(
  site: SiteDocument,
  registry: IModuleRegistry,
): RenderAccumulators {
  const acc: RenderAccumulators = {
    cssMap: new Map<string, string>(),
    jsMap: new Map<string, string>(),
    infiniteLoopIds: new Set<string>(),
    holeNodeIds: new Set<string>(),
  }
  for (const page of site.pages) {
    const config: RenderConfig = {
      page,
      site,
      registry,
      breakpointId: undefined,
    }
    renderNode(page.rootNodeId, config, acc)
  }
  return acc
}
```

- [ ] **Step 4: Create `server/publish/moduleJsBundle.ts`**

```ts
/**
 * Published module-JS channel — server-side builder + injector.
 *
 * `render()` may return `js` next to `html`/`css` (see `RenderOutput`). The
 * publisher dedupes it per moduleId into `RenderAccumulators.jsMap`; this file
 * owns the site-wide map and the page-level `<script>` injection:
 *
 * - `buildSiteModuleJsMap` rebuilds the map from scratch (preview, tests).
 * - `buildPublishedSiteModuleJsMap` memoises it by publishVersion + site
 *   object — the same pattern (and the same invalidation via
 *   `bumpPublishVersion()` / `registerVersionedCacheReset`) as
 *   `buildPublishedSiteCssBundle` in `siteCssBundle.ts`.
 * - `injectModuleScripts` is the post-render pipeline step: appends one
 *   `<script src="/_instatic/module-js/<id>.js?v=<version>" defer>` tag per
 *   moduleId (sorted for determinism) before `</body>` and relaxes the page
 *   CSP `script-src` to `'self'` iff at least one tag was injected.
 *
 * The matching asset route lives in `server/handlers/cms/moduleJs.ts`.
 */
import type { SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import { addCspSources, escapeHtml, rewriteCspMeta } from '@core/publisher'
import { collectSiteModuleAssets } from './siteModuleAssets'
import { getPublishVersion, registerVersionedCacheReset } from './publishState'

/** Build the moduleId → JS map fresh. Use for draft/preview/arbitrary sites. */
export function buildSiteModuleJsMap(
  site: SiteDocument,
  registry: IModuleRegistry,
): ReadonlyMap<string, string> {
  return collectSiteModuleAssets(site, registry).jsMap
}

// Memo keyed by publish version + site object, mirroring the page-invariant
// CSS bundle memo. A bump invalidates it; the shared test-reset hook clears it.
let moduleJsCache: {
  version: number
  site: SiteDocument
  map: ReadonlyMap<string, string>
} | null = null
registerVersionedCacheReset(() => {
  moduleJsCache = null
})

/**
 * Published-render variant: memoised per publishVersion + site object so the
 * O(all-pages) walk runs once per published snapshot, not once per render.
 * Safe ONLY for the published-snapshot render path (same caveat as
 * `buildPublishedSiteCssBundle`).
 */
export function buildPublishedSiteModuleJsMap(
  site: SiteDocument,
  registry: IModuleRegistry,
): ReadonlyMap<string, string> {
  const version = getPublishVersion()
  if (moduleJsCache && moduleJsCache.version === version && moduleJsCache.site === site) {
    return moduleJsCache.map
  }
  const map = buildSiteModuleJsMap(site, registry)
  moduleJsCache = { version, site, map }
  return map
}

/**
 * Append the page's module-JS `<script>` tags before `</body>` and relax the
 * CSP `script-src` to `'self'` iff at least one tag was injected.
 *
 * `jsModuleIds` must already be intersected with the site module-JS map (the
 * renderer does this — see `publicRenderer.ts`), so every emitted URL is
 * guaranteed to resolve. Sorted + de-duplicated here for deterministic output;
 * idempotent under repeated pipeline passes.
 */
export function injectModuleScripts(
  html: string,
  jsModuleIds: readonly string[],
  publishVersion: number,
): string {
  if (jsModuleIds.length === 0 || html.includes('data-instatic-module-js=')) return html
  const ids = [...new Set(jsModuleIds)].sort()
  const tags = ids
    .map(
      (id) =>
        `<script src="/_instatic/module-js/${encodeURIComponent(id)}.js?v=${publishVersion}" defer data-instatic-module-js="${escapeHtml(id)}"></script>`,
    )
    .join('\n')
  const withScripts = html.includes('</body>')
    ? html.replace('</body>', `${tags}\n</body>`)
    : `${html}\n${tags}`
  // External same-origin scripts only need `script-src 'self'` — merged as
  // data so ordering stays deterministic next to plugin/media relaxations.
  return rewriteCspMeta(withScripts, (csp) => addCspSources(csp, 'script-src', ["'self'"]))
}
```

- [ ] **Step 5: Point the CSS framework bundle at the shared walker** (`server/publish/siteCssBundle.ts`)

Replace `buildFrameworkCss` (lines 149-153) with:
```ts
function buildFrameworkCss(site: SiteDocument, registry: IModuleRegistry): string {
  const frameworkCss = buildSiteFrameworkCss(site)
  const moduleCss = Array.from(collectSiteModuleAssets(site, registry).cssMap.values()).join('\n')
  return [frameworkCss, moduleCss].filter(Boolean).join('\n')
}
```
DELETE the private `collectAllModuleCss` function (lines 155-188) outright, remove the now-unused `renderNode` import and `RenderConfig`/`RenderAccumulators` type imports from the import block (lines 35-48), and add:
```ts
import { collectSiteModuleAssets } from './siteModuleAssets'
```
(Keep the file's doc comment accurate: update the sentence referencing `collectAllModuleCss` to reference `collectSiteModuleAssets` in `siteModuleAssets.ts`.)

- [ ] **Step 6: Run tests + build**

Run: `bun test src/__tests__/server/moduleJsBundle.test.ts src/__tests__/publisher/ && bun run build`
Expected: new tests PASS; existing publisher/CSS-bundle tests stay green; build clean.

- [ ] **Step 7: Commit**

```bash
git add server/publish/siteModuleAssets.ts server/publish/moduleJsBundle.ts server/publish/siteCssBundle.ts src/__tests__/server/moduleJsBundle.test.ts
git commit -m "feat(server): site module-JS map and script injector

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Asset route `GET /_instatic/module-js/<moduleId>.js`

**Files:**
- Create: `server/handlers/cms/moduleJs.ts`
- Modify: `server/router.ts` (import near line 10; route table entry after `tryServeHole` at line 71; handler function after `tryServeHole` at line 169)
- Test: `src/__tests__/server/moduleJsRoute.test.ts` (new)
- Test: `src/__tests__/architecture/module-js-asset-route.test.ts` (new)

- [ ] **Step 1: Write the failing handler test**

Create `src/__tests__/server/moduleJsRoute.test.ts`:

```ts
/**
 * Tests for the `/_instatic/module-js/<moduleId>.js` asset endpoint.
 * Fake DbClient intercepts the published-snapshot query — same pattern as
 * holeRouteHandler.test.ts.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import {
  handleModuleJsAssetRequest,
  isModuleJsAssetPath,
} from '../../../server/handlers/cms/moduleJs'
import { resetForTests } from '../../../server/publish/renderCache'
import { makeModule } from '../publisher/helpers'
import { registry } from '../../core/module-engine/registry'

function makeSnapshot() {
  return {
    cmsSnapshotVersion: 1 as const,
    pageRowId: 'page_1',
    site: {
      id: 'site_1',
      name: 'Test Site',
      pages: [
        {
          id: 'page_1',
          title: 'Test Page',
          slug: 'test',
          rootNodeId: 'root',
          nodes: {
            root: {
              id: 'root',
              moduleId: 'test.body',
              props: {},
              breakpointOverrides: {},
              children: ['widget'],
              classIds: [],
            },
            widget: {
              id: 'widget',
              moduleId: 'test.jsy',
              props: {},
              breakpointOverrides: {},
              children: [],
              classIds: [],
            },
          },
        },
      ],
      files: [],
      visualComponents: [],
      breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
      settings: { metaTitle: 'Test', shortcuts: {} },
      styleRules: {},
      createdAt: 1000,
      updatedAt: 2000,
      packageJson: { dependencies: {}, devDependencies: {} },
      runtime: {
        dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
        scripts: {},
      },
    },
  }
}

function makeFakeDb(snapshot: ReturnType<typeof makeSnapshot> | null): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('select data_row_versions.snapshot_json')) {
      return {
        rows: snapshot ? [{ snapshot_json: snapshot } as Row] : [],
        rowCount: snapshot ? 1 : 0,
      }
    }
    return { rows: [], rowCount: 0 }
  }
  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)
  return handle as DbClient
}

function moduleJsRequest(path: string, method = 'GET'): [Request, URL] {
  const url = new URL(`http://localhost${path}`)
  return [new Request(url, { method }), url]
}

beforeEach(() => {
  resetForTests()
  registry.registerOrReplace(
    makeModule('test.body', {
      canHaveChildren: true,
      render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
    }),
  )
  registry.registerOrReplace(
    makeModule('test.jsy', {
      render: () => ({ html: '<div></div>', js: '(function(){/* test runtime */})();' }),
    }),
  )
})

describe('isModuleJsAssetPath', () => {
  it('matches the namespace prefix only', () => {
    expect(isModuleJsAssetPath('/_instatic/module-js/test.jsy.js')).toBe(true)
    expect(isModuleJsAssetPath('/_instatic/module-js/')).toBe(true)
    expect(isModuleJsAssetPath('/_instatic/module-js')).toBe(false)
    expect(isModuleJsAssetPath('/_instatic/hole-runtime.js')).toBe(false)
  })
})

describe('handleModuleJsAssetRequest', () => {
  it('serves a known module with text/javascript and a 1h public cache', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.jsy.js?v=0')
    const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(await res.text()).toContain('test runtime')
  })

  it('404s for a moduleId with no published js', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.body.js')
    const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
    expect(res.status).toBe(404)
  })

  it('404s for malformed / traversal-shaped ids without touching the map', async () => {
    for (const path of [
      '/_instatic/module-js/..%2F..%2Fetc%2Fpasswd.js',
      '/_instatic/module-js/UPPER.Case.js',
      '/_instatic/module-js/no-namespace.js',
      '/_instatic/module-js/test.jsy', // missing .js extension
      '/_instatic/module-js/',
    ]) {
      const [req, url] = moduleJsRequest(path)
      const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
      expect(res.status).toBe(404)
    }
  })

  it('404s when the site has never been published', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.jsy.js')
    const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(null) })
    expect(res.status).toBe(404)
  })

  it('405s non-GET methods', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.jsy.js', 'POST')
    const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
    expect(res.status).toBe(405)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/server/moduleJsRoute.test.ts`
Expected: FAIL — `Cannot find module '../../../server/handlers/cms/moduleJs'`.

- [ ] **Step 3: Create `server/handlers/cms/moduleJs.ts`**

```ts
/**
 * `/_instatic/module-js/<moduleId>.js` — per-module published-JS assets.
 *
 * Modules may return `js` from `render()` (see `RenderOutput`); the publisher
 * dedupes it per moduleId and pages reference it via
 * `<script src="/_instatic/module-js/<id>.js?v=<publishVersion>" defer>` tags
 * injected by `injectModuleScripts`. This endpoint serves the body from the
 * site-wide module-JS map, memoised per publish version through the same
 * versioned single-flight the hole endpoint uses (`?v=` is a pure
 * cache-buster — the content always reflects the LATEST published snapshot).
 *
 * The `<moduleId>` path segment is UNTRUSTED input: it is validated against
 * the namespaced-module-id grammar before any lookup, so traversal sequences
 * and junk ids are rejected with a plain 404 (public route — no error
 * envelope).
 */
import type { DbClient } from '../../db/client'
import { registry } from '@core/module-engine'
import { getLatestPublishedSiteSnapshot } from '../../repositories/publish'
import { buildPublishedSiteModuleJsMap } from '../../publish/moduleJsBundle'
import { createVersionedSingleFlight, getPublishVersion } from '../../publish/publishState'

const MODULE_JS_PATH_PREFIX = '/_instatic/module-js/'

/**
 * Namespaced module id grammar: `<namespace>.<name>[.<name>…]`, lowercase
 * alphanumerics and dashes per segment — matches the registry's id format
 * (`base.form`, `acme.hero-banner`) and the plugin namespace lock
 * (`SAFE_MODULE_NAME` in `moduleAdapter.ts`).
 */
const MODULE_JS_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/

export function isModuleJsAssetPath(pathname: string): boolean {
  return pathname.startsWith(MODULE_JS_PATH_PREFIX)
}

export interface ModuleJsHandlerContext {
  db: DbClient
}

// Version-keyed memo of the published module-JS map. Loading the snapshot +
// walking every page per request would be the same per-request cost the hole
// endpoint was flagged for — the single-flight runs the load once per publish
// version and the shared test-reset hook clears it.
const moduleJsMapCache = createVersionedSingleFlight<ReadonlyMap<string, string>>()

function loadModuleJsMapForVersion(
  db: DbClient,
  version: number,
): Promise<ReadonlyMap<string, string> | null> {
  return moduleJsMapCache.get(version, async () => {
    const snapshot = await getLatestPublishedSiteSnapshot(db)
    if (!snapshot) return null
    return buildPublishedSiteModuleJsMap(snapshot.site, registry)
  })
}

function plainResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/** GET `/_instatic/module-js/<moduleId>.js?v=<publishVersion>` → JS body. */
export async function handleModuleJsAssetRequest(
  req: Request,
  url: URL,
  ctx: ModuleJsHandlerContext,
): Promise<Response> {
  if (req.method !== 'GET') return plainResponse('Method not allowed', 405)

  const fileName = decodeURIComponent(url.pathname.slice(MODULE_JS_PATH_PREFIX.length))
  const moduleId = fileName.endsWith('.js') ? fileName.slice(0, -'.js'.length) : ''
  if (!moduleId || !MODULE_JS_ID_PATTERN.test(moduleId)) {
    return plainResponse('Not found', 404)
  }

  const jsMap = await loadModuleJsMapForVersion(ctx.db, getPublishVersion())
  const body = jsMap?.get(moduleId)
  if (body === undefined) return plainResponse('Not found', 404)

  return new Response(body, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      // 1 hour — `?v=<publishVersion>` on the referencing tag busts on publish.
      'cache-control': 'public, max-age=3600',
    },
  })
}
```

- [ ] **Step 4: Wire the router** (`server/router.ts`)

Add the import after line 10:
```ts
import { handleModuleJsAssetRequest, isModuleJsAssetPath } from './handlers/cms/moduleJs'
```
Add `tryServeModuleJsAsset,` to the `routes` table directly after `tryServeHole,` (line 71). Add the handler function after `tryServeHole` (after line 169):
```ts
/**
 * Per-module published JS — `/_instatic/module-js/<moduleId>.js`. Prefix-
 * namespaced: unknown paths under the prefix 404 inside the handler rather
 * than falling through to the public-slug resolver.
 */
function tryServeModuleJsAsset(req: Request, runtime: ServerRuntime, url: URL, pathname: string): Promise<Response> | null {
  if (!isModuleJsAssetPath(pathname)) return null
  return handleModuleJsAssetRequest(req, url, { db: runtime.db })
}
```

- [ ] **Step 5: Write the architecture gate**

Create `src/__tests__/architecture/module-js-asset-route.test.ts`:

```ts
/**
 * Architecture gate: `tryServeModuleJsAsset` must be registered in
 * `server/router.ts` BEFORE `tryServePublicRoute`, mirroring
 * `hole-runtime-asset-route.test.ts`. If the handler is missing or appears
 * after the public resolver, `/_instatic/module-js/...` requests would be
 * swallowed by the public-slug lookup and 404 as a page miss instead of
 * being answered by the module-JS asset handler.
 */
import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('module-js asset route ordering', () => {
  it('router registers tryServeModuleJsAsset', async () => {
    const source = await read('server/router.ts')
    expect(source).toContain('tryServeModuleJsAsset')
  })

  it('tryServeModuleJsAsset appears BEFORE tryServePublicRoute in the route table', async () => {
    const source = await read('server/router.ts')
    const tableMatch = source.match(/const routes:\s*readonly[^=]*=\s*\[([\s\S]*?)\]/)
    expect(tableMatch).not.toBeNull()
    const table = tableMatch![1]

    const moduleJsIdx = table.indexOf('tryServeModuleJsAsset')
    const publicIdx = table.indexOf('tryServePublicRoute')
    expect(moduleJsIdx).toBeGreaterThan(-1)
    expect(publicIdx).toBeGreaterThan(-1)
    expect(moduleJsIdx).toBeLessThan(publicIdx)
  })

  it('module-js handler imports are wired from server/handlers/cms/moduleJs', async () => {
    const source = await read('server/router.ts')
    expect(source).toContain("from './handlers/cms/moduleJs'")
    expect(source).toContain('isModuleJsAssetPath')
    expect(source).toContain('handleModuleJsAssetRequest')
  })
})
```

- [ ] **Step 6: Run tests**

Run: `bun test src/__tests__/server/moduleJsRoute.test.ts src/__tests__/architecture/module-js-asset-route.test.ts src/__tests__/architecture/hole-runtime-asset-route.test.ts`
Expected: PASS (including the existing hole gate — proves route-table edit didn't disturb ordering).

- [ ] **Step 7: Commit**

```bash
git add server/handlers/cms/moduleJs.ts server/router.ts src/__tests__/server/moduleJsRoute.test.ts src/__tests__/architecture/module-js-asset-route.test.ts
git commit -m "feat(server): serve per-module published JS at /_instatic/module-js/

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `base.form` emits the (rewritten) form runtime as module JS

**Files:**
- Create: `src/modules/base/forms/formRuntimeJs.ts`
- Modify: `src/modules/base/forms/index.ts:193-208` (base.form render)
- Test: `src/__tests__/publisher/formModuleJs.test.ts` (new)

The runtime is the existing `FORM_RUNTIME_JS` from `server/forms/formRuntime.ts:9-230` with three behavioural changes required by the channel's authoring contract (hole fragments insert into the DOM after load): (1) `pageId` is read per-form from `data-instatic-page-id` (stamped by `stampFormPageTokens` in Task 7) instead of from a script-tag attribute; (2) submit handling moves to document-level event delegation with lazy attach, so late-inserted forms work; (3) a `window` flag makes the whole IIFE idempotent.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/publisher/formModuleJs.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { FormModule } from '../../modules/base/forms'
import { FORM_RUNTIME_JS } from '../../modules/base/forms/formRuntimeJs'

describe('base.form module-JS emission', () => {
  it('emits the form runtime as js when mode is cms', () => {
    const out = FormModule.render({ ...FormModule.defaults, mode: 'cms' }, [])
    expect(out.js).toBe(FORM_RUNTIME_JS)
    expect(out.html).toContain('data-instatic-form-mode="cms"')
  })

  it('emits no js when mode is custom', () => {
    const out = FormModule.render({ ...FormModule.defaults, mode: 'custom' }, [])
    expect(out.js).toBeUndefined()
  })

  it('runtime binds via document-level delegation and reads pageId per form', () => {
    expect(FORM_RUNTIME_JS).toContain("document.addEventListener('submit'")
    expect(FORM_RUNTIME_JS).toContain('data-instatic-page-id')
    expect(FORM_RUNTIME_JS).toContain('/_instatic/form/challenge')
    expect(FORM_RUNTIME_JS).toContain('/_instatic/form/submit')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/publisher/formModuleJs.test.ts`
Expected: FAIL — `Cannot find module '../../modules/base/forms/formRuntimeJs'`.

- [ ] **Step 3: Create `src/modules/base/forms/formRuntimeJs.ts`**

```ts
/**
 * Browser runtime for CMS-native forms — shipped through the module-JS
 * channel: `base.form`'s render() returns this string as `js` when
 * `mode === 'cms'`, the publisher dedupes it per moduleId, and published
 * pages load it from `/_instatic/module-js/base.form.js`.
 *
 * Channel authoring contract (see RenderOutput.js):
 *   - self-contained vanilla IIFE, no framework runtime;
 *   - document-level event delegation, because hole fragments insert CMS
 *     forms into the DOM after load (forms present at load are attached
 *     eagerly; late-inserted forms attach on first focus or submit);
 *   - idempotent (window.__instaticFormRuntimeLoaded guard);
 *   - per-form identity: `data-instatic-form-id`, `data-instatic-page-id`,
 *     and `data-instatic-page-token` are stamped onto each <form> tag by
 *     `stampFormPageTokens` (server/forms/formRuntime.ts) for baked pages
 *     AND hole fragments.
 */
export const FORM_RUNTIME_JS = `(() => {
  if (window.__instaticFormRuntimeLoaded) return;
  window.__instaticFormRuntimeLoaded = true;

  const CMS_FORM_SELECTOR = 'form[data-instatic-form-mode="cms"][data-instatic-form-id]';

  for (const form of document.querySelectorAll(CMS_FORM_SELECTOR)) attachForm(form);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!isCmsForm(form)) return;
    event.preventDefault();
    attachForm(form);
    submitForm(form);
  });

  // Hole fragments insert forms after load — attach on first interaction so
  // labels/messages/challenge are prepared before the visitor submits.
  document.addEventListener('focusin', (event) => {
    const target = event.target;
    const form = target && target.closest ? target.closest(CMS_FORM_SELECTOR) : null;
    if (form) attachForm(form);
  });

  function isCmsForm(el) {
    return !!el && el.tagName === 'FORM'
      && el.getAttribute('data-instatic-form-mode') === 'cms'
      && !!el.getAttribute('data-instatic-form-id');
  }

  function attachForm(form) {
    if (form.__instaticFormRuntimeAttached) return;
    form.__instaticFormRuntimeAttached = true;
    connectLabels(form);
    prepareMessages(form);
    prefetchChallenge(form);
  }

  async function submitForm(form) {
    const formId = form.getAttribute('data-instatic-form-id') || '';
    const pageId = form.getAttribute('data-instatic-page-id') || '';
    const pageToken = form.getAttribute('data-instatic-page-token') || '';
    if (!formId || !pageId || !pageToken) {
      setState(form, 'error', 'This form is missing its published form link.');
      return;
    }

    setBusy(form, true);
    setState(form, 'pending', 'Sending...');

    try {
      const challenge = await takeChallenge(form);
      await postJson('/_instatic/form/submit', {
        pageId,
        formId,
        token: challenge.token,
        challenge: challenge.challenge,
        values: collectValues(form),
      });

      const redirectUrl = form.getAttribute('data-instatic-success-redirect') || '';
      if (redirectUrl) {
        window.location.assign(redirectUrl);
        return;
      }

      setState(form, 'success', form.getAttribute('data-instatic-success-message') || 'Thanks. Your submission was received.');
      if (form.getAttribute('data-instatic-reset-on-success') !== 'false') form.reset();
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Form submission failed.';
      setState(form, 'error', message);
    } finally {
      setBusy(form, false);
      if (form.isConnected) prefetchChallenge(form);
    }
  }

  function prefetchChallenge(form) {
    if (form.__instaticFormChallenge || form.__instaticFormChallengePromise) return form.__instaticFormChallengePromise;
    const request = requestChallenge(form)
      .then((challenge) => {
        form.__instaticFormChallenge = challenge;
        form.__instaticFormChallengePromise = null;
        return challenge;
      })
      .catch((err) => {
        form.__instaticFormChallenge = null;
        form.__instaticFormChallengePromise = null;
        throw err;
      });
    form.__instaticFormChallengePromise = request;
    request.catch(() => {});
    return request;
  }

  async function takeChallenge(form) {
    const existing = form.__instaticFormChallenge;
    if (existing && challengeIsFresh(existing)) {
      form.__instaticFormChallenge = null;
      return existing;
    }
    form.__instaticFormChallenge = null;
    const challenge = await prefetchChallenge(form);
    form.__instaticFormChallenge = null;
    return challenge;
  }

  function requestChallenge(form) {
    const formId = form.getAttribute('data-instatic-form-id') || '';
    const pageId = form.getAttribute('data-instatic-page-id') || '';
    const pageToken = form.getAttribute('data-instatic-page-token') || '';
    if (!formId || !pageId || !pageToken) {
      return Promise.reject(new Error('This form is missing its published form link.'));
    }
    return postJson('/_instatic/form/challenge', { pageId, formId, pageToken });
  }

  function challengeIsFresh(challenge) {
    const expiresAt = Date.parse(challenge && challenge.expiresAt ? challenge.expiresAt : '');
    return !Number.isFinite(expiresAt) || Date.now() < expiresAt - 10000;
  }

  async function postJson(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error(errorMessage(body));
    return body;
  }

  async function readJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_err) {
      return { error: 'Form submission failed.' };
    }
  }

  function errorMessage(body) {
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return body.errors.map((entry) => entry && entry.message ? entry.message : '').filter(Boolean).join('\\n') || 'Invalid form values.';
    }
    return typeof body.error === 'string' && body.error ? body.error : 'Form submission failed.';
  }

  function collectValues(form) {
    const values = {};
    const data = new FormData(form);
    for (const [name, value] of data.entries()) {
      const normalized = typeof value === 'string' ? value : value.name;
      if (values[name] === undefined) {
        values[name] = normalized;
      } else if (Array.isArray(values[name])) {
        values[name].push(normalized);
      } else {
        values[name] = [values[name], normalized];
      }
    }
    return values;
  }

  function connectLabels(form) {
    const elements = Array.from(form.querySelectorAll('label[data-instatic-label-target="auto"], input:not([type="hidden"]):not([data-instatic-honeypot]), textarea, select'));
    let counter = 0;
    for (const element of elements) {
      if (element.tagName.toLowerCase() !== 'label') continue;
      const index = elements.indexOf(element);
      const control = elements.slice(index + 1).find((candidate) => candidate.tagName.toLowerCase() !== 'label');
      if (!control) continue;
      if (!control.id) {
        counter += 1;
        control.id = 'instatic-form-' + safeToken(form.getAttribute('data-instatic-form-id') || 'form') + '-' + counter;
      }
      element.setAttribute('for', control.id);
    }
  }

  function safeToken(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'form';
  }

  function setBusy(form, busy) {
    form.setAttribute('aria-busy', busy ? 'true' : 'false');
    const buttons = form.querySelectorAll('button, input[type="submit"], input[type="button"]');
    for (const button of buttons) {
      if (busy) {
        if (button.disabled) button.setAttribute('data-instatic-was-disabled', 'true');
        button.disabled = true;
      } else if (!button.hasAttribute('data-instatic-was-disabled')) {
        button.disabled = false;
      } else {
        button.removeAttribute('data-instatic-was-disabled');
      }
    }
  }

  function prepareMessages(form) {
    for (const message of formMessages(form)) {
      if (!message.hasAttribute('data-instatic-default-text')) {
        message.setAttribute('data-instatic-default-text', message.textContent || '');
      }
      const kind = message.getAttribute('data-instatic-form-message') || 'status';
      if (kind === 'success' || kind === 'error') message.hidden = true;
    }
  }

  function setState(form, state, text) {
    form.setAttribute('data-instatic-form-state', state);
    const messages = formMessages(form);
    const messageKind = state === 'error' ? 'error' : state === 'success' ? 'success' : 'status';
    const hasExactMessage = messages.some((message) => (message.getAttribute('data-instatic-form-message') || 'status') === messageKind);

    for (const message of messages) {
      if (!message.hasAttribute('data-instatic-default-text')) {
        message.setAttribute('data-instatic-default-text', message.textContent || '');
      }
      const kind = message.getAttribute('data-instatic-form-message') || 'status';
      const shouldShow = kind === messageKind || (!hasExactMessage && kind === 'status');
      if (!shouldShow) {
        message.hidden = true;
        continue;
      }
      message.textContent = text || message.getAttribute('data-instatic-default-text') || '';
      message.hidden = !message.textContent;
    }
  }

  function formMessages(form) {
    const formId = form.getAttribute('data-instatic-form-id') || '';
    return Array.from(document.querySelectorAll('[data-instatic-form-message]')).filter((message) => {
      return form.contains(message) || (formId && message.getAttribute('data-instatic-form-id') === formId);
    });
  }
})();`
```

- [ ] **Step 4: Emit it from `base.form`** (`src/modules/base/forms/index.ts`)

Add the import after line 11 (`import { safeUrl } ...`):
```ts
import { FORM_RUNTIME_JS } from './formRuntimeJs'
```
Replace the `FormModule.render` return (line 207):
```ts
    return {
      html: `<form ${attrs}>${honeypot}${renderedChildren.join('')}</form>`,
      // CMS-native forms need the browser runtime; custom-action forms are
      // plain HTML form submissions and ship zero JS.
      ...(props.mode === 'cms' ? { js: FORM_RUNTIME_JS } : {}),
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/__tests__/publisher/formModuleJs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/base/forms/formRuntimeJs.ts src/modules/base/forms/index.ts src/__tests__/publisher/formModuleJs.test.ts
git commit -m "feat(forms): emit the CMS form runtime through base.form's js channel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Switch the pipeline to module-JS injection; DELETE the old form-runtime mechanism

**Files:**
- Modify: `server/forms/formRuntime.ts` (gut to `stampFormPageTokens` + helpers)
- Modify: `server/publish/publishedHtmlPipeline.ts:29-59`
- Modify: `server/publish/publicRenderer.ts:36-42, 66-113, 115-137`
- Modify: `server/handlers/cms/data/preview.ts:110-140`
- Modify: `server/router.ts` (delete `tryServePublicFormRuntimeAsset` at lines 171-174, its `routes` entry at line 72, and the import at line 12)
- Test: `src/__tests__/publisher/formRuntime.test.ts` (rewritten)

- [ ] **Step 1: Rewrite the form-runtime test for the new contract**

Replace the entire content of `src/__tests__/publisher/formRuntime.test.ts` with:

```ts
import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stampFormPageTokens } from '../../../server/forms/formRuntime'
import { FORM_RUNTIME_JS } from '../../modules/base/forms/formRuntimeJs'

const PAGE_WITH_CMS_FORM = `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; worker-src 'none'; style-src 'self'; img-src 'self' data:; connect-src 'self';">
</head>
<body>
<form data-instatic-form-mode="cms" data-instatic-form-id="contact"></form>
</body>
</html>`

describe('stampFormPageTokens', () => {
  it('stamps a page token and page id onto every CMS-native form tag', () => {
    const html = stampFormPageTokens(PAGE_WITH_CMS_FORM, 'page-home')
    expect(html).toContain('data-instatic-page-token=')
    expect(html).toContain('data-instatic-page-id="page-home"')
  })

  it('leaves non-CMS forms untouched', () => {
    const html = stampFormPageTokens(
      PAGE_WITH_CMS_FORM.replace('data-instatic-form-mode="cms"', 'data-instatic-form-mode="custom"'),
      'page-home',
    )
    expect(html).not.toContain('data-instatic-page-token=')
    expect(html).not.toContain('data-instatic-page-id=')
  })

  it('is idempotent', () => {
    const once = stampFormPageTokens(PAGE_WITH_CMS_FORM, 'page-home')
    const twice = stampFormPageTokens(once, 'page-home')
    expect(twice).toBe(once)
    expect(twice.match(/data-instatic-page-token=/g)?.length).toBe(1)
  })
})

describe('form runtime browser behaviour', () => {
  it('prefetches the submit challenge on attach and submits via document-level delegation', async () => {
    document.body.innerHTML = `
      <form data-instatic-form-mode="cms" data-instatic-form-id="contact" data-instatic-page-id="page-home" data-instatic-page-token="page-token">
        <input name="email" value="ai@example.com">
        <button type="submit">Send</button>
        <p data-instatic-form-message="status"></p>
      </form>
    `

    const calls: Array<{ path: string; payload: Record<string, unknown> }> = []
    const originalFetch = globalThis.fetch

    ;(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.pathname
          : input.url
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push({ path, payload })

      if (path === '/_instatic/form/challenge') {
        return new Response(JSON.stringify({
          token: 'prefetched-token',
          challenge: 'prefetched-challenge',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ ok: true, rowId: 'row-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    try {
      await importRuntimeScript(FORM_RUNTIME_JS)
      await flushRuntime()

      expect(calls.map((call) => call.path)).toEqual(['/_instatic/form/challenge'])
      expect(calls[0].payload.pageId).toBe('page-home')

      const form = document.querySelector('form')
      expect(form).not.toBeNull()
      // No per-form listener — submit is intercepted at document level.
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await waitForCalls(calls, 2)

      expect(calls[0].path).toBe('/_instatic/form/challenge')
      expect(calls[1].path).toBe('/_instatic/form/submit')
      expect(calls[1].payload.pageId).toBe('page-home')
      expect(calls[1].payload.token).toBe('prefetched-token')
      expect(calls[1].payload.challenge).toBe('prefetched-challenge')
    } finally {
      ;(globalThis as Record<string, unknown>).fetch = originalFetch
      document.body.innerHTML = ''
    }
  })
})

async function flushRuntime(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

let runtimeImportCounter = 0

async function importRuntimeScript(source: string): Promise<void> {
  runtimeImportCounter += 1
  const dir = join(process.cwd(), '.tmp', 'form-runtime-tests')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `runtime-${runtimeImportCounter}.mjs`)
  await writeFile(path, source, 'utf8')
  await import(`${pathToFileURL(path).href}?v=${runtimeImportCounter}`)
}

async function waitForCalls(calls: unknown[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (calls.length >= count) return
    await flushRuntime()
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/publisher/formRuntime.test.ts`
Expected: FAIL — `stampFormPageTokens` is not exported from `server/forms/formRuntime`.

- [ ] **Step 3: Gut `server/forms/formRuntime.ts`**

Replace the entire file content with:

```ts
/**
 * Form page-token stamping — the surviving server half of the CMS-form
 * publish path.
 *
 * The browser runtime itself ships through the module-JS channel
 * (`src/modules/base/forms/formRuntimeJs.ts`, emitted by `base.form`'s
 * render() when `mode === 'cms'`, served at `/_instatic/module-js/base.form.js`).
 * What CANNOT travel through render() is the per-page HMAC token — token
 * issuance needs the server signing secret — so `stampFormPageTokens` runs as
 * its own post-render step on every published page (publishedHtmlPipeline)
 * AND on every hole fragment (handleHoleRequest), stamping
 * `data-instatic-page-token` + `data-instatic-page-id` onto each CMS-native
 * `<form>` tag. Tokens are stateless HMAC signatures (no expiry), so baking
 * them into disk artefacts and cached fragments is safe.
 */
import { issuePublicFormPageToken } from './challenge'

const CMS_FORM_TAG_PATTERN = /<form\b(?=[^>]*\bdata-instatic-form-mode=(["'])cms\1)(?=[^>]*\bdata-instatic-form-id=(["'])[^"']+\2)[^>]*>/gi

export function stampFormPageTokens(html: string, pageId: string): string {
  return html.replace(CMS_FORM_TAG_PATTERN, (tag) => {
    if (/\bdata-instatic-page-token=/.test(tag)) return tag
    const formId = attrValue(tag, 'data-instatic-form-id')
    if (!formId) return tag
    const token = issuePublicFormPageToken({ pageId, formId })
    return tag.replace(
      /<form\b/i,
      `<form data-instatic-page-token="${escapeAttr(token)}" data-instatic-page-id="${escapeAttr(pageId)}"`,
    )
  })
}

function attrValue(tag: string, name: string): string {
  const pattern = new RegExp(`\\b${name}=(["'])(.*?)\\1`, 'i')
  const match = tag.match(pattern)
  return match?.[2] ?? ''
}

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
```
(This DELETES `FORM_RUNTIME_PATH`, `FORM_RUNTIME_JS`, `CMS_FORM_PATTERN`, `pageHasCmsNativeForm`, `injectFormRuntime`, `serveFormRuntimeAsset`, and `relaxScriptCsp` — no shims.)

- [ ] **Step 4: Extend `RendererOutput` and thread it** (`server/publish/publicRenderer.ts`)

Add to the imports: `buildPublishedSiteModuleJsMap`:
```ts
import { buildPublishedSiteModuleJsMap } from './moduleJsBundle'
```
Extend `RendererOutput` (lines 36-42):
```ts
export interface RendererOutput {
  html: string
  /** Identifies what was rendered, for the publish.html filter context. */
  pageId: string
  slug: string
  siteId: string
  /**
   * Sorted moduleIds whose published JS this page must load — already
   * intersected with the site module-JS map, so `injectModuleScripts` can
   * emit tags without any further lookup.
   */
  jsModuleIds: string[]
  /**
   * Publish version this page was rendered at (the bake passes the NEXT
   * version, live renders the current one) — stamped into module-js `?v=`
   * URLs so they cache-bust in lockstep with hole placeholders.
   */
  publishVersion: number
}
```
Change `renderMergedTemplate` (lines 66-89) to:
```ts
async function renderMergedTemplate(
  merged: Page,
  snapshot: PublishedPageSnapshot,
  templateContext: TemplateRenderDataContext | undefined,
  ctx: RenderPublishedSnapshotContext,
): Promise<{ html: string; jsModuleIds: string[]; publishVersion: number }> {
  const cssBundle = buildPublishedSiteCssBundle(snapshot.site, registry, merged)
  const moduleJsMap = buildPublishedSiteModuleJsMap(snapshot.site, registry)
  const [loopData, mediaAssets] = await Promise.all([
    prefetchLoopData(merged, snapshot.site, ctx.db, ctx.url),
    prefetchMediaAssets(merged, snapshot.site, registry, ctx.db),
  ])
  const publishVersion = ctx.publishVersion ?? getPublishVersion()
  const published = publishPage(merged, snapshot.site, registry, {
    templateContext,
    runtimeAssets: snapshot.runtimeAssets,
    runtimePackageImportmap: snapshot.runtimePackageImportmap,
    cssEmission: 'external',
    cssBundle,
    cssAssetBaseUrl: CSS_ASSET_BASE_URL,
    loopData,
    mediaAssets,
    loopEndpointBaseUrl: LOOP_ENDPOINT_BASE_URL,
    publishVersion,
  })
  // Per-page injection set = candidates from the render (emitted ∪ hole
  // subtrees) ∩ the site module-JS map — over-inclusive candidates from
  // unbaked holes are filtered down to modules that actually ship JS.
  const jsModuleIds = published.jsModuleIds.filter((id) => moduleJsMap.has(id))
  return { html: published.html, jsModuleIds, publishVersion }
}
```
Update both callers to spread the result:
```ts
  const rendered = await renderMergedTemplate(merged, snapshot, templateContext, ctx)
  return { ...rendered, pageId: snapshot.pageRowId, slug: page.slug, siteId: snapshot.site.id }
```
(and in `renderPublishedDataRowTemplate`:)
```ts
  const rendered = await renderMergedTemplate(merged, snapshot, templateContext, ctx)
  return { ...rendered, pageId: merged.id, slug: merged.slug, siteId: snapshot.site.id }
```

- [ ] **Step 5: Rewire the pipeline** (`server/publish/publishedHtmlPipeline.ts`)

Replace the import of `injectFormRuntime` (line 35) with:
```ts
import { stampFormPageTokens } from '../forms/formRuntime'
import { injectModuleScripts } from './moduleJsBundle'
```
Replace the body (lines 46-53) so the stages become:
```ts
  const injections = await collectFrontendInjections(db)
  const withInjections = injectFrontendAssets(rendered.html, injections)
  // Token stamping is an HTML mutation (needs the server signing secret) —
  // its own step, independent of JS injection.
  const withFormTokens = stampFormPageTokens(withInjections, rendered.pageId)
  // Module-JS channel: one external <script defer> per moduleId the page
  // needs; relaxes CSP script-src to 'self' iff at least one tag landed.
  const withModuleScripts = injectModuleScripts(
    withFormTokens,
    rendered.jsModuleIds,
    rendered.publishVersion,
  )
  const filtered = await hookBus.applyFilter('publish.html', withModuleScripts, {
```
Also update the file-header stage list (lines 9-22): replace the old stage 2½ description with `injectFrontendAssets → stampFormPageTokens → injectModuleScripts → publish.html filter`.

- [ ] **Step 6: Update the preview call site** (`server/handlers/cms/data/preview.ts:110-140`)

Change the `publishPage(...).html` call + pipeline invocation to:
```ts
  const published = publishPage(merged, snapshot.site, registry, {
    templateContext: {
      entryStack: [publishedDataRowToLoopItem(draftPublishedRow)],
      route: buildRouteFrame(syntheticUrl.toString()),
    },
    runtimeAssets: snapshot.runtimeAssets,
    runtimePackageImportmap: snapshot.runtimePackageImportmap,
    cssEmission: 'external',
    cssBundle,
    cssAssetBaseUrl: CSS_ASSET_BASE_URL,
    loopData,
    mediaAssets,
    loopEndpointBaseUrl: LOOP_ENDPOINT_BASE_URL,
  })
  const moduleJsMap = buildPublishedSiteModuleJsMap(snapshot.site, registry)

  const finalHtml = await applyPublishedHtmlPipeline(
    {
      html: published.html,
      pageId: merged.id,
      slug: merged.slug,
      siteId: snapshot.site.id,
      jsModuleIds: published.jsModuleIds.filter((id) => moduleJsMap.has(id)),
      publishVersion: getPublishVersion(),
    },
    db,
  )
```
Add the two imports to the file's import block:
```ts
import { buildPublishedSiteModuleJsMap } from '../../../publish/moduleJsBundle'
import { getPublishVersion } from '../../../publish/publishState'
```
(If `getPublishVersion` is already imported there, keep the single import.)

- [ ] **Step 7: Delete the old asset route** (`server/router.ts`)

Remove line 12 (`import { FORM_RUNTIME_PATH, serveFormRuntimeAsset } from './forms/formRuntime'`), the `tryServePublicFormRuntimeAsset,` entry in the `routes` table (line 72), and the `tryServePublicFormRuntimeAsset` function (lines 171-174).

- [ ] **Step 8: Run the affected suites**

Run: `bun test src/__tests__/publisher/formRuntime.test.ts src/__tests__/publisher/formModuleJs.test.ts src/__tests__/server/ src/__tests__/architecture/ && bun run build`
Expected: PASS + clean build. If `dispatcher-html-pipeline.test.ts` or `publicRouterCache.test.ts` fail, the cause must be in this diff (they exercise `renderPublicResolution` end-to-end); fix forward — do not re-add the deleted route.

- [ ] **Step 9: Commit**

```bash
git add server/forms/formRuntime.ts server/publish/publishedHtmlPipeline.ts server/publish/publicRenderer.ts server/handlers/cms/data/preview.ts server/router.ts src/__tests__/publisher/formRuntime.test.ts
git commit -m "feat(publisher): inject module JS via the published pipeline; delete form-runtime route

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Stamp form page tokens onto hole fragment HTML

**Files:**
- Modify: `server/handlers/cms/hole.ts:146-179` (`renderHoleFragment`)
- Test: `src/__tests__/server/holeRouteHandler.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/server/holeRouteHandler.test.ts` (after the existing `handleHoleRequest` describe blocks, reusing the file's `makeSnapshot`, `makeFakeDb`, `registry`, `makeModule`, and `getPublishVersion` imports):

```ts
describe('hole fragments and CMS forms', () => {
  it('stamps form page tokens + page id onto CMS-native forms inside fragments', async () => {
    registry.registerOrReplace(
      makeModule('test.cmsform', {
        render: () => ({
          html: '<form data-instatic-form-mode="cms" data-instatic-form-id="contact"></form>',
        }),
      }),
    )
    const snapshot = makeSnapshot()
    snapshot.site.pages[0].nodes['text-node'].moduleId = 'test.cmsform'

    const version = getPublishVersion()
    const url = new URL(`http://localhost/_instatic/hole/text-node?v=${version}`)
    const res = await handleHoleRequest(new Request(url), url, { db: makeFakeDb(snapshot) })

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-instatic-page-token=')
    expect(html).toContain('data-instatic-page-id="page_1"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/server/holeRouteHandler.test.ts`
Expected: the new test FAILS (`data-instatic-page-token=` not found); all existing tests pass.

- [ ] **Step 3: Stamp tokens in `renderHoleFragment`** (`server/handlers/cms/hole.ts`)

Add the import after line 44:
```ts
import { stampFormPageTokens } from '../../forms/formRuntime'
```
Change the last line of `renderHoleFragment` (line 178) from `return renderNode(nodeId, config, acc)` to:
```ts
  // Hole fragments bypass the published-HTML pipeline, so CMS forms inside
  // them would never receive their page token. Stamp here — tokens are
  // stateless HMAC signatures, safe to store in the Layer B fragment cache.
  return stampFormPageTokens(renderNode(nodeId, config, acc), page.id)
```
Also extend the doc comment block at the top of the file (lines 1-31): add one line — `Fragments get form page tokens stamped (stampFormPageTokens) so CMS forms inside holes can submit; the form runtime itself reaches the page via the module-JS channel's static hole-subtree walk.`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/server/holeRouteHandler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/handlers/cms/hole.ts src/__tests__/server/holeRouteHandler.test.ts
git commit -m "fix(holes): stamp form page tokens onto hole fragment HTML

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Plugin channel — `js` across the VM boundary, gated by `frontend.assets`

**Files:**
- Modify: `src/core/plugin-sdk/modules.ts:46-49`
- Modify: `server/plugins/quickjs/bootstrap/src/modulePackRuntime.ts:28-35` (then `bun run bootstrap:sync`)
- Modify: `server/plugins/modulePackVm.ts:50-53`
- Modify: `src/core/plugins/modulePackLoader.ts:80-97, 144-216`
- Modify: `src/core/plugins/moduleAdapter.ts:119-181`
- Test: `src/__tests__/server/modulePackVm.test.ts` (add tests)
- Test: `src/__tests__/plugins/pluginModulePack.test.ts` (update + add tests)
- Generated: `server/plugins/quickjs/bootstrap/generated/modulePackBootstrap.ts` (via sync only)

- [ ] **Step 1: Write the failing VM-boundary tests**

Add to `src/__tests__/server/modulePackVm.test.ts` (new describe at the end, reusing the file's `createModulePackVm` import):

```ts
describe('modulePackVm — render js boundary', () => {
  const JS_PACK = `
const widget = {
  id: 'acme.canvas.widget',
  name: 'Widget',
  category: 'Acme',
  version: '1.0.0',
  defaults: {},
  schema: {},
  render: () => ({ html: '<div></div>', js: '(function(){})();' }),
};
const badJs = {
  id: 'acme.canvas.badjs',
  name: 'BadJs',
  category: 'Acme',
  version: '1.0.0',
  defaults: {},
  schema: {},
  render: () => ({ html: '<div></div>', js: 42 }),
};
export default [widget, badJs];
`

  it('passes string render() js through the VM boundary', async () => {
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: JS_PACK })
    try {
      const out = vm.render('acme.canvas.widget', {}, [])
      expect(out.html).toBe('<div></div>')
      expect(out.js).toBe('(function(){})();')
    } finally {
      vm.dispose()
    }
  })

  it('drops non-string js at the VM boundary', async () => {
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: JS_PACK })
    try {
      expect(vm.render('acme.canvas.badjs', {}, []).js).toBeUndefined()
    } finally {
      vm.dispose()
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/__tests__/server/modulePackVm.test.ts`
Expected: FAIL — `out.js` is `undefined` for the widget (normalizer strips it) and a TS error on `out.js` until `ModulePackRenderOutput` gains the field.

- [ ] **Step 3: Add `js` to the SDK mirror** (`src/core/plugin-sdk/modules.ts`, lines 46-49 become)

```ts
export interface PluginRenderOutput {
  html: string
  css?: string
  /**
   * Optional vanilla-JS runtime for this module TYPE — deduped per moduleId
   * and served as an external per-module asset on published pages
   * (`/_instatic/module-js/<moduleId>.js`). Requires the plugin's GRANTED
   * `frontend.assets` permission; without the grant the host drops it (one
   * console warning per module). Must be a self-contained IIFE binding via
   * document-level event delegation; never executed in the admin canvas.
   */
  js?: string
}
```

- [ ] **Step 4: Pass `js` through the VM normalizer** (`server/plugins/quickjs/bootstrap/src/modulePackRuntime.ts`, lines 28-35 become)

```ts
/** Normalize a render()/preview() return into the `{ html, css, js }` wire shape. */
function normalizeRenderOutput(out: unknown): { html: string; css?: string; js?: string } {
  const o = out as { html?: unknown; css?: unknown; js?: unknown } | null
  return {
    html: o && typeof o === 'object' && typeof o.html === 'string' ? o.html : '',
    css: o && typeof o === 'object' && typeof o.css === 'string' ? o.css : undefined,
    js: o && typeof o === 'object' && typeof o.js === 'string' ? o.js : undefined,
  }
}
```

- [ ] **Step 5: Regenerate the committed bootstrap artifact**

Run: `bun run bootstrap:sync`
Expected: `server/plugins/quickjs/bootstrap/generated/modulePackBootstrap.ts` changes (git shows it modified). Never edit the generated file by hand.

- [ ] **Step 6: Update host-side wire types**

`server/plugins/modulePackVm.ts` lines 50-53 become:
```ts
export interface ModulePackRenderOutput {
  html: string
  css?: string
  js?: string
}
```
`src/core/plugins/modulePackLoader.ts` — in `SandboxedModulePack` (lines 162-163), change both signatures to:
```ts
  render(moduleId: string, props: Record<string, unknown>, children: string[]): { html: string; css?: string; js?: string }
  preview(moduleId: string, props: Record<string, unknown>, children: string[]): { html: string; css?: string; js?: string }
```

- [ ] **Step 7: Run VM tests + freshness gate**

Run: `bun test src/__tests__/server/modulePackVm.test.ts src/__tests__/architecture/plugin-bootstrap-fresh.test.ts`
Expected: PASS.

- [ ] **Step 8: Write the failing adapter-gating tests**

In `src/__tests__/plugins/pluginModulePack.test.ts`, first add `, []` as the new fourth argument to every existing `pluginModuleToHostModule(...)` call (lines 99, 109, 112, 124 at base commit), then add inside the `describe('pluginModuleToHostModule', ...)` block:

```ts
  it('drops render() js without the frontend.assets grant and warns once per module', () => {
    const jsDefinition = {
      ...counterDefinition,
      id: 'acme.canvas.jsy',
      render: () => ({ html: '<div></div>', js: '(function(){})();' }),
    }
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      const hostModule = pluginModuleToHostModule('acme.canvas', jsDefinition, () => () => null, [])
      expect(hostModule.render({}, []).js).toBeUndefined()
      expect(hostModule.render({}, []).js).toBeUndefined()
      expect(warnings.filter((w) => w.includes('frontend.assets')).length).toBe(1)
      expect(warnings[0]).toContain('[plugin-module:acme.canvas.jsy]')
    } finally {
      console.warn = originalWarn
    }
  })

  it('passes render() js through with the frontend.assets grant', () => {
    const jsDefinition = {
      ...counterDefinition,
      id: 'acme.canvas.jsy',
      render: () => ({ html: '<div></div>', js: '(function(){})();' }),
    }
    const hostModule = pluginModuleToHostModule('acme.canvas', jsDefinition, () => () => null, ['frontend.assets'])
    expect(hostModule.render({}, []).js).toBe('(function(){})();')
  })
```

- [ ] **Step 9: Run to verify failure**

Run: `bun test src/__tests__/plugins/pluginModulePack.test.ts`
Expected: FAIL — `pluginModuleToHostModule` does not accept 4 arguments.

- [ ] **Step 10: Gate `js` in the adapter** (`src/core/plugins/moduleAdapter.ts`)

Change the function signature (lines 119-123) to:
```ts
export function pluginModuleToHostModule(
  pluginId: string,
  definition: PluginModuleDefinition,
  componentFactory: PluginModuleComponentFactory,
  /**
   * The plugin's GRANTED permissions (never the declared `permissions`
   * array) — authority for the `frontend.assets` gate on module JS.
   */
  grantedPermissions: readonly string[],
): ModuleDefinition<Record<string, unknown>> {
```
After the `render`-is-function validation block (after line 131), add:
```ts
  // `frontend.assets` is the existing permission meaning "may put script tags
  // on published pages" (enforced against grantedPermissions the same way in
  // server/publish/frontendInjections.ts). Module render() `js` rides the
  // same authority; without the grant it is dropped with ONE warning per
  // module so a publish over hundreds of nodes doesn't spam the log.
  const allowModuleJs = grantedPermissions.includes('frontend.assets')
  let warnedDroppedJs = false
```
Replace the render wrap (lines 171-179) with:
```ts
    render: (props, children) => {
      try {
        const out = definition.render(props, children)
        if (out.js !== undefined && !allowModuleJs) {
          if (!warnedDroppedJs) {
            warnedDroppedJs = true
            console.warn(
              `[plugin-module:${definition.id}] render() emitted js but plugin "${pluginId}" was not granted "frontend.assets" — module JS dropped.`,
            )
          }
          return { html: out.html, css: out.css }
        }
        return { html: out.html, css: out.css, js: out.js }
      } catch (err) {
        console.error(`[plugin-module:${definition.id}] render() threw:`, err)
        return { html: `<!-- instatic: plugin module "${definition.id}" render failed -->` }
      }
    },
```

- [ ] **Step 11: Thread grants from both activation paths** (`src/core/plugins/modulePackLoader.ts`)

In `activatePluginModulePack` (line 92):
```ts
    const hostModule = pluginModuleToHostModule(
      manifest.id,
      definition,
      componentFactory,
      manifest.grantedPermissions ?? [],
    )
```
In `activateSandboxedPluginModulePack` (line 208):
```ts
    const hostModule = pluginModuleToHostModule(
      manifest.id,
      definition,
      STUB_COMPONENT_FACTORY,
      manifest.grantedPermissions ?? [],
    )
```
(Every server call site builds the manifest via `pluginManifestWithGrants(plugin)` or `{ ...plugin.manifest, grantedPermissions: plugin.grantedPermissions }`, so the granted set is authoritative here.)

- [ ] **Step 12: Run the plugin suites + build**

Run: `bun test src/__tests__/plugins/ src/__tests__/server/modulePackVm.test.ts src/__tests__/architecture/plugin-bootstrap-fresh.test.ts && bun run build`
Expected: PASS + clean build (the build catches any missed 4-arg call site, e.g. in `editorPluginLoader.test.ts` fixtures — fix those the same mechanical way).

- [ ] **Step 13: Commit**

```bash
git add src/core/plugin-sdk/modules.ts server/plugins/quickjs/bootstrap/src/modulePackRuntime.ts server/plugins/quickjs/bootstrap/generated/modulePackBootstrap.ts server/plugins/modulePackVm.ts src/core/plugins/modulePackLoader.ts src/core/plugins/moduleAdapter.ts src/__tests__/server/modulePackVm.test.ts src/__tests__/plugins/pluginModulePack.test.ts
git commit -m "feat(plugins): pass module js across the VM boundary gated by frontend.assets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/features/publisher.md` (CSP section ~line 321; server-side wrappers table ~lines 333-355; pipeline diagram ~lines 360-369)
- Modify: `docs/features/modules.md` (render contract ~lines 145-157)
- Modify: `docs/features/plugin-system.md` (capability matrix ~line 676; new subsection after the hole-hydration section ~line 450)
- Modify: `docs/features/cms-native-forms.md` (line 13)

- [ ] **Step 1: publisher.md — CSP bullet**

Replace the line at ~321:
```
- The native-form runtime (`server/forms/formRuntime.ts`) merges `script-src 'self'` through the same `rewriteCspMeta` helper.
```
with:
```
- The module-JS injector (`injectModuleScripts` in `server/publish/moduleJsBundle.ts`) merges `script-src 'self'` through the same `rewriteCspMeta` helper — only when at least one `/_instatic/module-js/<moduleId>.js` script tag was injected.
```

- [ ] **Step 2: publisher.md — server-side wrappers table**

Add three rows (and update the `siteCssBundle.ts` row's description to mention it consumes `siteModuleAssets.ts`):
```
| `server/publish/siteModuleAssets.ts`            | `collectSiteModuleAssets` — the one full-site render walk whose accumulators feed BOTH the framework CSS bundle (`cssMap`) and the published module-JS map (`jsMap`). |
| `server/publish/moduleJsBundle.ts`              | Module-JS channel: `buildSiteModuleJsMap` (fresh), `buildPublishedSiteModuleJsMap` (memoised per publishVersion + site, invalidated by `bumpPublishVersion()`), and `injectModuleScripts` (per-page `<script defer>` tags + CSP `script-src 'self'` relaxation). |
| `server/handlers/cms/moduleJs.ts`               | `GET /_instatic/module-js/<moduleId>.js?v=<publishVersion>` — serves a module's render-emitted JS from the memoised site map; validates the untrusted moduleId segment; 404 unknown; `text/javascript`; `cache-control: public, max-age=3600`. |
```

- [ ] **Step 3: publisher.md — pipeline diagram (~lines 360-369)**

Inside the `applyPublishedHtmlPipeline` stage list, after the `frontend.assets[]` splice line, add:
```
    ├─→ Stamp form page tokens onto CMS-native <form> tags (`stampFormPageTokens`)
    ├─→ Inject per-module published JS: one `<script src="/_instatic/module-js/<id>.js?v=N" defer data-instatic-module-js="<id>">` per moduleId in the page's injection set (render-emitted ∪ hole-subtree ∩ site jsMap), sorted; CSP script-src → 'self' iff ≥ 1 tag
```
And add a short `## Module JS channel` section after the CSP section:
```
## Module JS channel

`render()` may return `js` next to `html`/`css` (`RenderOutput`, `src/core/module-engine/types.ts`). The walker dedupes it per moduleId into `RenderAccumulators.jsMap`; `publishPage` reports per-page candidates (`jsModuleIds` = render-emitted ids ∪ every moduleId inside the page's hole subtrees via `collectHoleSubtreeModuleIds`); the server intersects candidates with the site-wide map (`buildPublishedSiteModuleJsMap`) and injects one external `<script defer>` per module before `</body>`. JS is never inlined — no `</script>` escaping anywhere. Pages with no module JS ship zero script tags and keep `script-src 'none'`. The CMS form runtime is the first consumer: `base.form` emits it when `mode === 'cms'` (`src/modules/base/forms/formRuntimeJs.ts`); token stamping stays server-side (`stampFormPageTokens`, applied to baked pages and hole fragments).
```

- [ ] **Step 4: modules.md — render contract**

In the `ModuleDefinition` listing (~line 150), keep `render: (props, children) => RenderOutput` and after the `Constraint #179` paragraph (~line 157) add:
```
`render()` may also return `js` next to `html`/`css` — an optional vanilla-JS runtime for the module TYPE, deduplicated per moduleId (like CSS) and served as an external file at `/_instatic/module-js/<moduleId>.js` on published pages. Authoring contract: a self-contained IIFE; bind via document-level event delegation (hole fragments insert into the DOM after load); idempotent; no load-order assumptions; no framework runtimes. Size discipline in the spirit of the ~1 KB hole runtime — the ~8 KB form runtime is the ceiling, not the norm. Module JS never executes in the admin canvas: the canvas renders React editor components, never published render() output.
```

- [ ] **Step 5: plugin-system.md**

Update the capability-matrix row at ~line 676 to:
```
| `frontend.assets`           | Frontend / manifest  | High      | Inject declarative tags into every published page; also gates module render() `js` |
```
Add after the "How a hole hydrates" section (~line 450):
```
### Module JS on published pages — requires `frontend.assets`

A plugin module's `render()` may return `js` (see `PluginRenderOutput`). It crosses the QuickJS boundary string-typed (non-strings are dropped by the VM normalizer) and is then gated host-side in `moduleAdapter.ts`: unless the plugin's **granted** permissions include `frontend.assets` — the same authority that already controls script tags via `frontend.assets[]` — the `js` is dropped with one `console.warn` per module. Enforcement always checks `grantedPermissions`, never the declared `permissions` array. With the grant, the JS is deduped per moduleId and served at `/_instatic/module-js/<moduleId>.js` on pages that use the module. Manifest format is unchanged.
```

- [ ] **Step 6: cms-native-forms.md line 13**

Replace:
```
- Published pages that contain CMS-native forms get `/_instatic/form-runtime.js` injected by `server/forms/formRuntime.ts`.
```
with:
```
- The browser runtime ships through the module-JS channel: `base.form`'s render() emits it as `js` when `mode === 'cms'` (`src/modules/base/forms/formRuntimeJs.ts`), published pages load it from `/_instatic/module-js/base.form.js`, and `server/forms/formRuntime.ts`'s `stampFormPageTokens` stamps `data-instatic-page-token` + `data-instatic-page-id` onto every CMS form tag — on baked pages and on hole fragments.
```

- [ ] **Step 7: Sanity-grep for stale doc references**

Run: `grep -rn "form-runtime.js\|injectFormRuntime\|pageHasCmsNativeForm" docs/ && echo STALE || echo CLEAN`
Expected: `CLEAN` (no matches).

- [ ] **Step 8: Commit**

```bash
git add docs/features/publisher.md docs/features/modules.md docs/features/plugin-system.md docs/features/cms-native-forms.md
git commit -m "docs: document the module JS channel and form-runtime migration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification

**Files:** none (verification only; commit only if fixes were needed).

- [ ] **Step 1: Clean install**

Run: `bun install`
Expected: completes without errors (lockfile unchanged).

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: green. Triage rule: only failures **caused by this branch** matter — if a test fails, check it against the base with `git stash && bun test <file> && git stash pop` (or run the same file at `0503316e`); pre-existing failures are out of scope and must NOT be "fixed" here. Likely branch-caused hotspots: anything touching `RenderAccumulators` literals, `RendererOutput` construction, `pluginModuleToHostModule` arity, and route-table ordering gates.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: `tsc -b && vite build` clean — this is the cross-file type gate for `jsMap`, `jsModuleIds`, `publishVersion`, and the adapter's fourth parameter.

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: clean. Fix any unused-import leftovers (e.g. in `siteCssBundle.ts` or `formRuntime.ts`) in this branch.

- [ ] **Step 5: Bootstrap idempotency**

Run:
```bash
bun run bootstrap:sync
git status --porcelain server/plugins/quickjs/bootstrap/generated/
```
Expected: empty output (re-running the sync produces byte-identical committed artifacts; `plugin-bootstrap-fresh.test.ts` already passed in Step 2).

- [ ] **Step 6: Commit any verification fixes**

Only if Steps 2-5 required changes:
```bash
git add -A
git commit -m "fix: address verification fallout for module-JS channel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

*Plan ends.*
