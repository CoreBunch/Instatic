/**
 * Editor store benchmark — the "is the builder laggy?" answer.
 *
 * Drives the live Zustand+Immer editor store the way the actual visual
 * builder UI drives it. Measures pure data-mutation cost (no React,
 * no DOM) — so what we observe is the algorithmic floor below which any
 * UI lag must originate from rendering, not state.
 *
 * Scenarios:
 *   - Class creation: how does `createClass()` scale to 100 / 1k / 10k / 100k?
 *   - Class lookup: random access to a node's resolved class list
 *   - Node insertion / deletion / movement at 100 / 1k / 10k node trees
 *   - History push (undo stack growth) and memory bookkeeping
 *   - Node-class assignment with huge class catalogues
 *   - Multi-delete: one `deleteNodes(ids)` batch on a large tree
 *   - VC-mode keystroke sweep: `updateNodeProps` on a Visual Component text
 *     node while the site holds many pages (slot-sync propagation cost)
 *   - Undo coalescing burst: a long single-prop typing burst and the memory
 *     the history stack retains afterwards
 *
 * The user-facing question this answers:
 *   "If I add 10,000 CSS classes, does the builder start dropping frames?"
 *
 * The data-mutation answer ("does the algorithm scale?") is here. If a
 * mutation is microseconds, any UI jank elsewhere comes from rendering,
 * not state.
 */
import { performance } from 'node:perf_hooks'
import type { BenchModule, BenchResult, BenchRow, BenchContext } from '../lib/types'
import { summarize, fmtMs, fmtNum, fmtBytes } from '../lib/stats'
import { log } from '../lib/log'

// Load the live editor store. Imports `@admin/state/adminUi` which is
// admin-shell only, but the actions themselves don't touch the DOM.
async function loadStore() {
  // Side effect — registers base modules so insertNode finds them.
  await import('../../../src/modules/base')
  const { useEditorStore } = await import('../../../src/admin/pages/site/store/store')
  return useEditorStore
}

function resetStore(useStore: Awaited<ReturnType<typeof loadStore>>): void {
  useStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hasUnsavedChanges: false,
    activeDocument: null,
    activePageId: null,
  })
}

function setupSite(useStore: Awaited<ReturnType<typeof loadStore>>): void {
  resetStore(useStore)
  const s = useStore.getState() as { createSite: (name: string) => void }
  s.createSite('Bench Site')
}

function estimateSiteHeap(useStore: Awaited<ReturnType<typeof loadStore>>): number {
  // Approximate the in-memory cost of the site document via JSON length —
  // useful as a "did adding N classes blow up memory?" signal. Accurate
  // bytes would need v8.getHeapStatistics() which doesn't break down by
  // owner; this approximation is good enough for trend lines.
  try {
    const site = (useStore.getState() as { site: unknown }).site
    return JSON.stringify(site ?? {}).length
  } catch {
    return -1
  }
}

// ---------------------------------------------------------------------------
// Synthetic site assembly — used by the multi-delete and VC-mode scenarios to
// hydrate a large document through the public `loadSite` action instead of
// paying N insertNode round-trips per node.
// ---------------------------------------------------------------------------

interface StoreNode {
  id: string
  moduleId: string
  props: Record<string, unknown>
  breakpointOverrides: Record<string, unknown>
  children: string[]
  classIds: string[]
}

interface StorePage {
  id: string
  slug: string
  title: string
  nodes: Record<string, StoreNode>
  rootNodeId: string
}

/**
 * Build a ~`target`-node page (base.body root, base.container / base.text
 * children, 4 children per parent) — same synthetic shape the publisher bench
 * uses. Node ids are minted in BFS order, so an even-stride pick over
 * `Object.keys(nodes)` selects nodes across the whole depth range.
 */
function buildStorePage(prefix: string, slug: string, target: number): StorePage {
  const nodes: Record<string, StoreNode> = {}
  const rootId = `${prefix}-n0`
  nodes[rootId] = { id: rootId, moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] }
  let counter = 1
  const queue: string[] = [rootId]
  while (counter < target && queue.length > 0) {
    const parentId = queue.shift()!
    const childCount = Math.min(4, target - counter)
    const kids: string[] = []
    for (let i = 0; i < childCount; i++) {
      const childId = `${prefix}-n${counter++}`
      const isContainer = i < 2
      nodes[childId] = {
        id: childId,
        moduleId: isContainer ? 'base.container' : 'base.text',
        props: isContainer ? { tag: 'div' } : { text: `node ${childId}`, tag: 'p' },
        breakpointOverrides: {},
        children: [],
        classIds: [],
      }
      if (isContainer) queue.push(childId)
      kids.push(childId)
    }
    nodes[parentId].children = kids
  }
  return { id: `${prefix}-page`, slug, title: `Bench ${prefix}`, nodes, rootNodeId: rootId }
}

/**
 * Hydrate the store with a synthetic multi-page document: clone the default
 * site that `createSite` mints (keeps settings/framework/runtime canonical),
 * swap in the synthetic pages, and load it through the public `loadSite`
 * action — which reindexes parents and resets history exactly like a real
 * site load.
 */
function loadSyntheticSite(useStore: Awaited<ReturnType<typeof loadStore>>, pages: StorePage[]): void {
  setupSite(useStore)
  const baseSite = (useStore.getState() as { site: object | null }).site
  if (!baseSite) throw new Error('createSite produced no site — store layout has changed; update editor-store bench.')
  const clone = structuredClone(baseSite) as { pages: StorePage[] }
  clone.pages = pages
  const state = useStore.getState() as { loadSite: (site: unknown) => void }
  state.loadSite(clone)
}

function unavailableRow(label: string, err: unknown): BenchRow {
  const message = err instanceof Error ? err.message : String(err)
  return { label, metrics: { status: `unavailable: ${message}` } }
}

interface ClassResults {
  classCount: number
  perCreateMean: number
  perCreateP95: number
  totalMs: number
  heapBytes: number
}

async function benchClassCreation(
  useStore: Awaited<ReturnType<typeof loadStore>>,
  classCount: number,
): Promise<ClassResults> {
  setupSite(useStore)
  const state = useStore.getState() as {
    createClass: (name: string, styles?: Record<string, unknown>) => unknown
  }
  // Time every create — we want to see whether the curve flattens (O(1)) or
  // grows (O(N)) as N grows. We sample every Kth call to keep memory
  // bounded but capture the trend.
  const sampleEvery = Math.max(1, Math.floor(classCount / 1000))
  const samples: number[] = []
  const totalStart = performance.now()
  for (let i = 0; i < classCount; i++) {
    const t0 = performance.now()
    state.createClass(`bench-class-${i}`, {
      color: `hsl(${(i * 137) % 360}deg 60% 50%)`,
      padding: `${(i % 4) * 4}px`,
    })
    const dur = performance.now() - t0
    if (i % sampleEvery === 0) samples.push(dur)
  }
  const totalMs = performance.now() - totalStart
  const s = summarize(samples)
  const heapBytes = estimateSiteHeap(useStore)
  return {
    classCount,
    perCreateMean: s.mean,
    perCreateP95: s.p95,
    totalMs,
    heapBytes,
  }
}

function readActivePage(useStore: Awaited<ReturnType<typeof loadStore>>): { id: string; rootNodeId: string } | null {
  const state = useStore.getState() as {
    site: { pages: Array<{ id: string; rootNodeId: string }> } | null
    activePageId: string | null
  }
  if (!state.site || !state.activePageId) return null
  return state.site.pages.find((p) => p.id === state.activePageId) ?? null
}

async function benchTreeMutations(
  useStore: Awaited<ReturnType<typeof loadStore>>,
  nodeCount: number,
): Promise<{ insertMs: number; deleteMs: number; insertSamples: number[]; deleteSamples: number[]; finalHeap: number; activePageId: string | null }> {
  setupSite(useStore)
  const state = useStore.getState() as {
    insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string, index?: number) => string
    deleteNode: (nodeId: string) => void
  }
  const page = readActivePage(useStore)
  if (!page) throw new Error('No active page after createSite — store layout has changed; update editor-store bench.')
  const rootId = page.rootNodeId

  const insertSamples: number[] = []
  const insertedIds: string[] = []
  const sampleEvery = Math.max(1, Math.floor(nodeCount / 500))
  const insertStart = performance.now()
  for (let i = 0; i < nodeCount; i++) {
    const t0 = performance.now()
    const id = state.insertNode('base.text', { text: `n${i}`, tag: 'p' }, rootId)
    const dur = performance.now() - t0
    insertedIds.push(id)
    if (i % sampleEvery === 0) insertSamples.push(dur)
  }
  const insertMs = performance.now() - insertStart

  const finalHeap = estimateSiteHeap(useStore)

  // Now delete every other inserted node — measures the deleteNode cost
  // when the tree is well-populated.
  const deleteSamples: number[] = []
  const deleteStart = performance.now()
  for (let i = 0; i < insertedIds.length; i += 2) {
    const t0 = performance.now()
    state.deleteNode(insertedIds[i])
    const dur = performance.now() - t0
    if (i % (sampleEvery * 2) === 0) deleteSamples.push(dur)
  }
  const deleteMs = performance.now() - deleteStart

  return { insertMs, deleteMs, insertSamples, deleteSamples, finalHeap, activePageId: (useStore.getState() as { activePageId: string | null }).activePageId }
}

export const editorStoreBench: BenchModule = {
  name: 'editor-store',
  title: 'Editor store — mutation + class system scaling',
  description: 'Drives the live Zustand store with realistic class & tree workloads; answers "is the builder laggy at scale?".',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const useStore = await loadStore()

    // ---- Class creation scaling -----------------------------------------
    // Current `createClass` is O(N) per op (`Object.values(site.styleRules).find`
    // uniqueness check) → O(N²) total. 100k full-mode is intentionally a
    // measure of that — runs ~20min at 100k. Adjust if the algorithm changes.
    const classCounts = ctx.quick ? [100, 1_000] : [100, 1_000, 10_000]
    log.step('Class creation scaling')
    const classRows: BenchRow[] = []
    let lastResult: ClassResults | null = null
    for (const n of classCounts) {
      log.step(`  creating ${fmtNum(n)} classes…`)
      const result = await benchClassCreation(useStore, n)
      lastResult = result
      classRows.push({
        label: `${fmtNum(n)} classes`,
        inputs: { classes: n },
        metrics: {
          per_create_mean: fmtMs(result.perCreateMean),
          per_create_p95: fmtMs(result.perCreateP95),
          total: fmtMs(result.totalMs),
          state_heap: fmtBytes(result.heapBytes),
          throughput: `${fmtNum(Math.floor(n / (result.totalMs / 1000)))} ops/sec`,
        },
      })
      log.detail(`    per-op mean=${fmtMs(result.perCreateMean)} p95=${fmtMs(result.perCreateP95)} total=${fmtMs(result.totalMs)}`)
    }

    // ---- Class lookup scaling -------------------------------------------
    log.step('Class lookup throughput (Record<string, CSSClass> read)')
    const lookupRows: BenchRow[] = []
    {
      // Catalogue seeding is dominated by createClass cost (O(N²) overall in
      // the current implementation), so cap quick-mode catalogues hard.
      const lookupCounts = ctx.quick ? [100, 1_000] : [100, 1_000, 10_000]
      for (const n of lookupCounts) {
        setupSite(useStore)
        const state = useStore.getState() as { createClass: (name: string) => { id: string } }
        const ids: string[] = []
        for (let i = 0; i < n; i++) ids.push(state.createClass(`lookup-${i}`).id)

        const site = (useStore.getState() as { site: { styleRules: Record<string, unknown> } }).site
        const iters = ctx.quick ? 50_000 : 200_000
        // Warmup
        for (let i = 0; i < 1000; i++) {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          site.styleRules[ids[i % ids.length]]
        }
        const t0 = performance.now()
        let sink: unknown = null
        for (let i = 0; i < iters; i++) {
          sink = site.styleRules[ids[i % ids.length]]
        }
        const elapsedMs = performance.now() - t0
        if (!sink) throw new Error('lookup never read a value (unreachable)')
        lookupRows.push({
          label: `${fmtNum(n)} classes`,
          inputs: { classes: n, lookups: iters },
          metrics: {
            ns_per_lookup: `${((elapsedMs * 1_000_000) / iters).toFixed(0)} ns`,
            throughput: `${fmtNum(Math.floor((iters / elapsedMs) * 1000))} lookups/s`,
          },
        })
      }
    }

    // ---- Node tree mutations --------------------------------------------
    log.step('Node tree mutations (insertNode / deleteNode)')
    const treeRows: BenchRow[] = []
    {
      const sizes = ctx.quick ? [100, 1_000] : [100, 1_000, 5_000, 10_000]
      for (const n of sizes) {
        log.step(`  ${fmtNum(n)}-node tree`)
        const r = await benchTreeMutations(useStore, n)
        const insertSummary = summarize(r.insertSamples)
        const deleteSummary = summarize(r.deleteSamples)
        treeRows.push({
          label: `${fmtNum(n)}-node tree`,
          inputs: { nodes_inserted: n },
          metrics: {
            insert_total: fmtMs(r.insertMs),
            insert_mean_per_op: fmtMs(insertSummary.mean),
            insert_p95: fmtMs(insertSummary.p95),
            delete_total: fmtMs(r.deleteMs),
            delete_mean_per_op: fmtMs(deleteSummary.mean),
            delete_p95: fmtMs(deleteSummary.p95),
            final_heap: fmtBytes(r.finalHeap),
          },
        })
        log.detail(`    insert: ${fmtMs(r.insertMs)} (${fmtMs(insertSummary.mean)}/op)  delete½: ${fmtMs(r.deleteMs)} (${fmtMs(deleteSummary.mean)}/op)`)
      }
    }

    // ---- Node-class assignment with a huge catalogue --------------------
    log.step('Node-class assignment under large catalogue')
    const assignRows: BenchRow[] = []
    {
      // Same constraint as the lookup bench — catalogue seed is the long pole.
      const cataloguePresets = ctx.quick ? [100, 1_000] : [100, 1_000, 10_000]
      for (const catalogueSize of cataloguePresets) {
        setupSite(useStore)
        const state = useStore.getState() as {
          createClass: (name: string) => { id: string }
          insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string) => string
          addNodeClass: (nodeId: string, classId: string) => void
        }
        // Seed catalogue
        const classIds: string[] = []
        for (let i = 0; i < catalogueSize; i++) classIds.push(state.createClass(`cat-${i}`).id)
        const page = readActivePage(useStore)
        if (!page) continue
        // Add one target node and assign many classes to it
        const targetId = state.insertNode('base.text', { text: 'target', tag: 'p' }, page.rootNodeId)
        const ASSIGNS = ctx.quick ? 200 : 1_000
        const samples: number[] = []
        for (let i = 0; i < ASSIGNS; i++) {
          const t0 = performance.now()
          state.addNodeClass(targetId, classIds[i % classIds.length])
          samples.push(performance.now() - t0)
        }
        const s = summarize(samples)
        assignRows.push({
          label: `${fmtNum(catalogueSize)} classes in catalogue`,
          inputs: { catalogue: catalogueSize, assignments: ASSIGNS },
          metrics: {
            mean: fmtMs(s.mean),
            p95: fmtMs(s.p95),
            p99: fmtMs(s.p99),
            throughput: `${fmtNum(Math.floor(1000 / s.mean))} ops/s`,
          },
        })
      }
    }

    // ---- Multi-delete -----------------------------------------------------
    log.step('Multi-delete (one deleteNodes batch)')
    const multiDeleteRows: BenchRow[] = []
    {
      const TREE = ctx.quick ? 2_000 : 10_000
      const PICK = ctx.quick ? 100 : 500
      const RUNS = 3
      try {
        const totals: number[] = []
        for (let run = 0; run < RUNS; run++) {
          const page = buildStorePage(`md${run}`, 'index', TREE)
          loadSyntheticSite(useStore, [page])
          // Even-stride pick over BFS-ordered ids → selection spans all depths.
          const candidates = Object.keys(page.nodes).filter((id) => id !== page.rootNodeId)
          const ids: string[] = []
          for (let i = 0; i < PICK; i++) {
            ids.push(candidates[Math.floor((i * candidates.length) / PICK)])
          }
          const state = useStore.getState() as { deleteNodes: (nodeIds: string[]) => void }
          const t0 = performance.now()
          state.deleteNodes(ids)
          totals.push(performance.now() - t0)
          log.detail(`    run ${run + 1}/${RUNS}: ${fmtMs(totals[totals.length - 1])}`)
        }
        const s = summarize(totals)
        multiDeleteRows.push({
          label: `delete ${fmtNum(PICK)} of ${fmtNum(TREE)} nodes`,
          inputs: { tree_nodes: TREE, deleted_ids: PICK, runs: RUNS },
          metrics: {
            mean_total: fmtMs(s.mean),
            min: fmtMs(s.min),
            max: fmtMs(s.max),
            mean_per_id: fmtMs(s.mean / PICK),
          },
        })
      } catch (err) {
        multiDeleteRows.push(unavailableRow(`delete ${fmtNum(PICK)} of ${fmtNum(TREE)} nodes`, err))
      }
    }

    // ---- VC-mode keystroke sweep -------------------------------------------
    log.step('VC-mode keystroke sweep (updateNodeProps on a Visual Component)')
    const vcSweepRows: BenchRow[] = []
    {
      const PAGES = ctx.quick ? 5 : 20
      const NODES = ctx.quick ? 200 : 500
      const ITERS = ctx.quick ? 50 : 200
      try {
        const pages = Array.from({ length: PAGES }, (_, i) =>
          buildStorePage(`vcp${i}`, i === 0 ? 'index' : `vc-page-${i}`, NODES),
        )
        loadSyntheticSite(useStore, pages)
        const state = useStore.getState() as {
          createVisualComponent: (name: string) => string
          setActiveDocument: (doc: { kind: 'visualComponent'; vcId: string }) => void
          insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string) => string
          updateNodeProps: (nodeId: string, patch: Record<string, unknown>) => void
        }
        const vcId = state.createVisualComponent('Bench VC')
        state.setActiveDocument({ kind: 'visualComponent', vcId })
        const vc = (useStore.getState() as {
          site: { visualComponents: Array<{ id: string; tree: { rootNodeId: string } }> }
        }).site.visualComponents.find((v) => v.id === vcId)
        if (!vc) throw new Error('createVisualComponent did not register the VC in site.visualComponents')
        // insertNode routes through mutateActiveTree → VC mode, so the text
        // node lands in the VC's own tree.
        const textNodeId = state.insertNode('base.text', { text: 'seed', tag: 'p' }, vc.tree.rootNodeId)
        if (!textNodeId) throw new Error('insertNode into the VC tree returned no id')
        const samples: number[] = []
        for (let i = 0; i < ITERS; i++) {
          const t0 = performance.now()
          state.updateNodeProps(textNodeId, { text: 'x'.repeat(i + 1) })
          samples.push(performance.now() - t0)
        }
        const s = summarize(samples)
        vcSweepRows.push({
          label: `${fmtNum(ITERS)} keystrokes, ${fmtNum(PAGES)} pages × ${fmtNum(NODES)} nodes`,
          inputs: { pages: PAGES, nodes_per_page: NODES, keystrokes: ITERS },
          metrics: {
            mean_per_op: fmtMs(s.mean),
            p95: fmtMs(s.p95),
            throughput: `${fmtNum(Math.floor(1000 / s.mean))} ops/s`,
          },
        })
        log.detail(`    per-op mean=${fmtMs(s.mean)} p95=${fmtMs(s.p95)}`)
      } catch (err) {
        vcSweepRows.push(unavailableRow(`${fmtNum(ITERS)} keystrokes, ${fmtNum(PAGES)} pages × ${fmtNum(NODES)} nodes`, err))
      }
    }

    // ---- set() latency with N canvas-like subscribers -----------------------
    // Zustand re-runs EVERY subscriber's selector on EVERY store set. The
    // canvas mounts ~6 per-node subscriptions per rendered node per breakpoint
    // frame (NodeRenderer), so the hottest editor events — hoverNode on every
    // mouse crossing, updateNodeProps on every keystroke — pay a full selector
    // sweep. This scenario registers the same selectors NodeRenderer uses and
    // measures the set() cost they add. Without subscribers (the scenarios
    // above) this cost is invisible.
    log.step('set() latency with N canvas-like subscribers')
    const subscriberSweepRows: BenchRow[] = []
    {
      const PAGES = ctx.quick ? 5 : 20
      const NODES = ctx.quick ? 200 : 500
      const FRAMES = 3
      const HOVERS = ctx.quick ? 100 : 300
      const KEYS = ctx.quick ? 50 : 150
      try {
        const { selectActiveCanvasPage } = await import('../../../src/admin/pages/site/store/store')
        const { getCanvasNodeClassName } = await import('../../../src/admin/pages/site/canvas/canvasNodeClassName')
        const { resolveEditorFormPreviewState, resolveEditorFormPreviewSuccessMessage } = await import(
          '../../../src/admin/pages/site/canvas/canvasFormPreview'
        )

        const pages = Array.from({ length: PAGES }, (_, i) =>
          buildStorePage(`sw${i}`, i === 0 ? 'index' : `sweep-page-${i}`, NODES),
        )
        loadSyntheticSite(useStore, pages)
        const state = useStore.getState() as {
          site: { pages: Array<{ id: string; nodes: Record<string, StoreNode> }> }
          activePageId: string
          hoverNode: (nodeId: string | null, breakpointId?: string | null) => void
          updateNodeProps: (nodeId: string, patch: Record<string, unknown>) => void
        }
        const activePage = state.site.pages.find((p) => p.id === state.activePageId)
        if (!activePage) throw new Error('No active page after loadSite — update editor-store bench.')
        const nodeIds = Object.keys(activePage.nodes)

        type S = Parameters<typeof selectActiveCanvasPage>[0]
        const noop = () => {}
        const unsubs: Array<() => void> = []
        for (let frame = 0; frame < FRAMES; frame++) {
          for (const nodeId of nodeIds) {
            unsubs.push(useStore.subscribe((s: S) => selectActiveCanvasPage(s)?.nodes[nodeId] ?? null, noop))
            unsubs.push(useStore.subscribe((s: S) => s.selectedNodeIds.includes(nodeId), noop))
            unsubs.push(useStore.subscribe((s: S) => s.hoveredNodeId === nodeId, noop))
            unsubs.push(useStore.subscribe(
              (s: S) => (s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null),
              noop,
            ))
            unsubs.push(useStore.subscribe((s: S) => resolveEditorFormPreviewState(s, nodeId), noop))
            unsubs.push(useStore.subscribe((s: S) => resolveEditorFormPreviewSuccessMessage(s, nodeId), noop))
            unsubs.push(useStore.subscribe((s: S) => {
              const canvasNode = selectActiveCanvasPage(s)?.nodes[nodeId]
              const preview = s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null
              return getCanvasNodeClassName(canvasNode?.classIds, preview, nodeId, s.site?.styleRules)
            }, noop))
          }
        }

        try {
          const hoverSamples: number[] = []
          for (let i = 0; i < HOVERS; i++) {
            const target = nodeIds[i % nodeIds.length]
            const t0 = performance.now()
            state.hoverNode(target)
            hoverSamples.push(performance.now() - t0)
          }
          const textNodeId = nodeIds.find((id) => activePage.nodes[id].moduleId === 'base.text')
          if (!textNodeId) throw new Error('Synthetic page has no text node — update editor-store bench.')
          const keySamples: number[] = []
          for (let i = 0; i < KEYS; i++) {
            const t0 = performance.now()
            state.updateNodeProps(textNodeId, { text: 'x'.repeat(i + 1) })
            keySamples.push(performance.now() - t0)
          }
          const hover = summarize(hoverSamples)
          const keys = summarize(keySamples)
          subscriberSweepRows.push({
            label: `${fmtNum(unsubs.length)} subscribers (${fmtNum(NODES)} nodes × ${FRAMES} frames), ${fmtNum(PAGES)} pages`,
            inputs: { pages: PAGES, nodes: NODES, frames: FRAMES, subscribers: unsubs.length },
            metrics: {
              hover_mean: fmtMs(hover.mean),
              hover_p95: fmtMs(hover.p95),
              keystroke_mean: fmtMs(keys.mean),
              keystroke_p95: fmtMs(keys.p95),
            },
          })
          log.detail(`    hover mean=${fmtMs(hover.mean)} p95=${fmtMs(hover.p95)}  keystroke mean=${fmtMs(keys.mean)} p95=${fmtMs(keys.p95)}`)
        } finally {
          for (const unsub of unsubs) unsub()
        }
      } catch (err) {
        subscriberSweepRows.push(unavailableRow(`${fmtNum(NODES)} nodes × ${FRAMES} frames canvas subscriber sweep`, err))
      }
    }

    // ---- Undo coalescing burst ----------------------------------------------
    log.step('Undo coalescing burst (single-prop typing burst + retained history)')
    const coalesceRows: BenchRow[] = []
    {
      const KEYS = ctx.quick ? 300 : 2_000
      try {
        setupSite(useStore)
        const page = readActivePage(useStore)
        if (!page) throw new Error('No active page after createSite — store layout has changed; update editor-store bench.')
        const state = useStore.getState() as {
          insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string) => string
          updateNodeProps: (nodeId: string, patch: Record<string, unknown>) => void
        }
        const textNodeId = state.insertNode('base.text', { text: '', tag: 'p' }, page.rootNodeId)
        // A single-key patch is exactly what the Properties panel sends per
        // keystroke — `updateNodeProps` derives the `props:<nodeId>:text`
        // coalesce key from it, so the whole burst folds into ONE undo entry.
        const samples: number[] = []
        for (let i = 0; i < KEYS; i++) {
          const t0 = performance.now()
          state.updateNodeProps(textNodeId, { text: 'x'.repeat(i + 1) })
          samples.push(performance.now() - t0)
        }
        const s = summarize(samples)
        const past = (useStore.getState() as { _historyPast: unknown[] })._historyPast
        const historyBytes = JSON.stringify(past).length
        coalesceRows.push({
          label: `${fmtNum(KEYS)}-keystroke burst on one text node`,
          inputs: { keystrokes: KEYS },
          metrics: {
            mean_per_op: fmtMs(s.mean),
            p95_per_op: fmtMs(s.p95),
            history_entries: fmtNum(past.length),
            history_bytes: fmtBytes(historyBytes),
          },
        })
        log.detail(`    per-op p95=${fmtMs(s.p95)} history=${fmtNum(past.length)} entries, ${fmtBytes(historyBytes)}`)
      } catch (err) {
        coalesceRows.push(unavailableRow(`${fmtNum(KEYS)}-keystroke burst on one text node`, err))
      }
    }

    // Headline picks the worst-case class creation so it's visible if it
    // ever becomes bad. The other slots pull whatever the largest tree /
    // lookup test we ran was (covers both quick and full modes).
    const worstClassN = lastResult?.classCount ?? 0
    const worstClassP95 = lastResult ? fmtMs(lastResult.perCreateP95) : '—'
    const largestTreeRow = treeRows[treeRows.length - 1]
    const largestLookupRow = lookupRows[lookupRows.length - 1]
    const multiDeleteRow = multiDeleteRows[0]
    const vcSweepRow = vcSweepRows[0]
    return {
      name: this.name,
      title: this.title,
      headline: {
        [`createClass p95 @ ${fmtNum(worstClassN)} classes`]: worstClassP95,
        [`${largestTreeRow?.label ?? 'tree'} insert mean`]: largestTreeRow?.metrics.insert_mean_per_op ?? '—',
        [`${largestLookupRow?.label ?? 'lookup'} ns/op`]: largestLookupRow?.metrics.ns_per_lookup ?? '—',
        [`multi-${multiDeleteRow?.label ?? 'delete'}`]: multiDeleteRow?.metrics.mean_total ?? '—',
        [`VC sweep ${vcSweepRow?.label ?? ''} mean`]: vcSweepRow?.metrics.mean_per_op ?? '—',
      },
      sections: [
        {
          title: 'Class creation scaling',
          intro:
            'How does `createClass()` cost grow as the existing class count grows? Watch p95 — flat means O(1)/amortized, climbing means linear scans.',
          rows: classRows,
        },
        {
          title: 'Class lookup throughput',
          intro: 'Random `site.styleRules[id]` lookups — the floor below which any class-related rendering must live.',
          rows: lookupRows,
        },
        {
          title: 'Node tree mutations',
          intro:
            'Sequential insertNode then delete-every-other-node on the same tree. Measures the raw store-mutation cost the visual builder pays.',
          rows: treeRows,
        },
        {
          title: 'Node-class assignment with large catalogues',
          intro:
            'Assigning class IDs to a single node when the site already has N classes defined. Tests whether classlist append is sensitive to catalogue size.',
          rows: assignRows,
        },
        {
          title: 'Multi-delete',
          intro:
            'ONE `deleteNodes(ids)` call removing hundreds of ids (spread across all depths) from a large tree, repeated on fresh trees. This is the canvas multi-select → Delete path; it pays per-id depth ordering plus subtree removal in one undo step.',
          rows: multiDeleteRows,
        },
        {
          title: 'VC-mode keystroke sweep',
          intro:
            'Per-keystroke `updateNodeProps` on a text node inside a Visual Component while the site holds many pages. Every VC-mode mutation re-syncs slot instances across all consumer trees, so this measures whether typing inside a VC scales with total site size.',
          rows: vcSweepRows,
        },
        {
          title: 'set() latency with canvas-like subscribers',
          intro:
            'hoverNode / updateNodeProps latency with NodeRenderer-equivalent per-node Zustand subscriptions registered (nodes × 3 frames × 7 selectors). Measures the selector-sweep cost every canvas-visible store set pays — the cost the zero-subscriber scenarios above cannot see.',
          rows: subscriberSweepRows,
        },
        {
          title: 'Undo coalescing burst',
          intro:
            'A long single-prop typing burst on one text node — the Properties-panel per-keystroke path, which coalesces into a single undo entry. `history_bytes` is the JSON size of the retained `_historyPast` stack after the burst: what one typing session keeps pinned in memory.',
          rows: coalesceRows,
        },
      ],
    }
  },
}
