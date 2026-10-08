/**
 * Publisher render benchmark.
 *
 * Exercises the page-tree → HTML/CSS pipeline that produces the actual
 * static pages shipped to visitors. The whole point of the CMS is that
 * the published output is hand-clean — this bench locks in the cost of
 * that promise.
 *
 * Scenarios:
 *   - Tree-size scaling (1 to 50,000 nodes)
 *   - Per-node CSS classes (light vs heavy class application)
 *   - Site CSS bundle build (reset + framework + N user classes)
 *   - Output size: HTML, gzip, brotli per tree size
 */
import { performance } from 'node:perf_hooks'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import type { BenchModule, BenchResult, BenchRow, BenchContext } from '../lib/types'
import { summarize, fmtMs, fmtBytes, fmtNum } from '../lib/stats'
import { log } from '../lib/log'
import type { Page, PageNode, SiteDocument, StyleRule } from '@core/page-tree'

// Lazy imports — keep cold startup fast when this bench is skipped.
async function loadEngine() {
  await import('../../../src/modules/base')
  const { publishPage } = await import('../../../src/core/publisher')
  const { registry } = await import('../../../src/core/module-engine')
  const { buildSiteCssBundle } = await import('../../../server/publish/siteCssBundle')
  return { publishPage, registry, buildSiteCssBundle }
}

function emptySite(): SiteDocument {
  return {
    id: 'site-bench',
    name: 'Bench Site',
    pages: [],
    files: [],
    visualComponents: [],
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {}, styles: {} },
    breakpoints: [],
    settings: { shortcuts: {} },
    styleRules: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

function buildNode(id: string, moduleId: string, overrides: Partial<PageNode> = {}): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children: [],
    classIds: [],
    ...overrides,
  }
}

function buildTreeOfSize(target: number, options: { classIdsPerNode?: number; availableClassIds?: string[] } = {}): Page {
  const { classIdsPerNode = 0, availableClassIds = [] } = options
  const nodes: Record<string, PageNode> = {}
  const rootId = 'n0'
  nodes[rootId] = buildNode(rootId, 'base.body')
  let counter = 1
  const queue: string[] = [rootId]
  while (counter < target && queue.length > 0) {
    const parentId = queue.shift()!
    const childCount = Math.min(4, target - counter)
    const kids: string[] = []
    for (let i = 0; i < childCount; i++) {
      const childId = `n${counter++}`
      const isContainer = i < 2
      const cls: string[] = []
      if (classIdsPerNode > 0 && availableClassIds.length > 0) {
        for (let c = 0; c < classIdsPerNode; c++) {
          cls.push(availableClassIds[(counter + c) % availableClassIds.length])
        }
      }
      if (isContainer) {
        nodes[childId] = buildNode(childId, 'base.container', { classIds: cls })
        queue.push(childId)
      } else {
        nodes[childId] = buildNode(childId, 'base.text', {
          props: { text: `Lorem ipsum dolor sit amet — node ${childId}`, tag: 'p' },
          classIds: cls,
        })
      }
      kids.push(childId)
    }
    nodes[parentId] = { ...nodes[parentId]!, children: kids }
  }
  return {
    id: 'page-bench',
    slug: 'bench',
    title: `Bench page (${Object.keys(nodes).length} nodes)`,
    nodes,
    rootNodeId: rootId,
  }
}

function buildClasses(n: number): Record<string, StyleRule> {
  const out: Record<string, StyleRule> = {}
  for (let i = 0; i < n; i++) {
    const id = `cls-${i}`
    out[id] = {
      id,
      name: `bench-class-${i}`,
      kind: 'class',
      selector: `.bench-class-${i}`,
      order: i,
      styles: {
        color: `hsl(${(i * 137) % 360}deg 60% 50%)`,
        padding: `${(i % 4) * 4}px`,
        fontSize: `${12 + (i % 8)}px`,
      },
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    }
  }
  return out
}

export const publisherBench: BenchModule = {
  name: 'publisher',
  title: 'Publisher render pipeline',
  description: 'Page-tree → static HTML/CSS. Measures core promise of "clean HTML, no framework runtime".',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const engine = await loadEngine()
    const { publishPage, registry, buildSiteCssBundle } = engine
    const site = emptySite()

    const treeSizes = ctx.quick ? [10, 100, 500] : [1, 20, 100, 500, 2000, 5000, 20_000, 50_000]
    const iterCounts = (n: number): number => {
      if (ctx.quick) return Math.max(20, Math.floor(2000 / Math.max(1, Math.log10(n + 1) * n)))
      if (n <= 100) return 5000
      if (n <= 500) return 1000
      if (n <= 2000) return 300
      if (n <= 5000) return 80
      if (n <= 20_000) return 20
      return 8
    }

    log.step('Building benchmark site fixture')
    const treeRows: BenchRow[] = []
    for (const target of treeSizes) {
      const page = buildTreeOfSize(target)
      const actualNodes = Object.keys(page.nodes).length
      const iters = iterCounts(actualNodes)
      log.step(`  ${fmtNum(actualNodes)}-node page × ${iters} iters`)
      // warmup
      let html = ''
      for (let i = 0; i < Math.min(10, iters); i++) html = publishPage(page, site, registry).html
      const samples: number[] = []
      for (let i = 0; i < iters; i++) {
        const t0 = performance.now()
        html = publishPage(page, site, registry).html
        samples.push(performance.now() - t0)
      }
      const s = summarize(samples)
      const bytes = Buffer.byteLength(html, 'utf8')
      const gz = gzipSync(html).length
      const br = brotliCompressSync(html).length
      treeRows.push({
        label: `${fmtNum(actualNodes)}-node page`,
        inputs: { nodes: actualNodes, iters },
        metrics: {
          mean: fmtMs(s.mean),
          p50: fmtMs(s.p50),
          p95: fmtMs(s.p95),
          p99: fmtMs(s.p99),
          pages_per_sec: fmtNum(1000 / s.mean),
          html: fmtBytes(bytes),
          gzip: fmtBytes(gz),
          brotli: fmtBytes(br),
        },
      })
    }

    // Class application stress — how does N classes per node affect render?
    log.step('Class-application stress')
    const classRows: BenchRow[] = []
    {
      const classCounts = ctx.quick ? [100] : [100, 1_000, 10_000]
      for (const classCount of classCounts) {
        const classes = buildClasses(classCount)
        const availableClassIds = Object.keys(classes)
        const siteWithClasses = { ...emptySite(), styleRules: classes }
        for (const classesPerNode of [0, 5, 20]) {
          const page = buildTreeOfSize(500, { classIdsPerNode: classesPerNode, availableClassIds })
          const iters = ctx.quick ? 50 : 200
          for (let i = 0; i < 5; i++) publishPage(page, siteWithClasses, registry)
          const samples: number[] = []
          for (let i = 0; i < iters; i++) {
            const t0 = performance.now()
            publishPage(page, siteWithClasses, registry)
            samples.push(performance.now() - t0)
          }
          const s = summarize(samples)
          classRows.push({
            label: `500 nodes / ${fmtNum(classesPerNode)} classes/node / ${fmtNum(classCount)} total`,
            inputs: { nodes: 500, classes_total: classCount, classes_per_node: classesPerNode },
            metrics: {
              mean: fmtMs(s.mean),
              p95: fmtMs(s.p95),
              pages_per_sec: fmtNum(1000 / s.mean),
            },
          })
        }
      }
    }

    // CSS bundle build cost as user-class count grows
    log.step('CSS bundle build (N user classes)')
    const cssRows: BenchRow[] = []
    {
      const classCounts = ctx.quick ? [0, 100, 1_000] : [0, 100, 1_000, 10_000]
      for (const classCount of classCounts) {
        const classes = buildClasses(classCount)
        const siteWithClasses = { ...emptySite(), styleRules: classes }
        const page = buildTreeOfSize(1)
        page.nodes[page.rootNodeId].classIds = Object.keys(classes)
        siteWithClasses.pages = [page]
        for (let i = 0; i < 5; i++) buildSiteCssBundle(siteWithClasses, registry, page)
        const samples: number[] = []
        const iters = ctx.quick ? 30 : 100
        for (let i = 0; i < iters; i++) {
          const t0 = performance.now()
          buildSiteCssBundle(siteWithClasses, registry, page)
          samples.push(performance.now() - t0)
        }
        const s = summarize(samples)
        const bundle = buildSiteCssBundle(siteWithClasses, registry, page)
        const totalBytes = (bundle.reset?.content?.length ?? 0) + (bundle.framework?.content?.length ?? 0) + (bundle.style?.content?.length ?? 0)
        cssRows.push({
          label: `${fmtNum(classCount)} user classes`,
          inputs: { classes: classCount, iters },
          metrics: {
            mean: fmtMs(s.mean),
            p95: fmtMs(s.p95),
            bundle: fmtBytes(totalBytes),
          },
        })
      }
    }

    // Headline = the smallest typical landing page + the largest tree we
    // actually rendered. In quick mode we top out at 500 nodes, so we pick
    // whatever the biggest tested size was rather than hard-coding 5,000.
    const firstTreeRow = treeRows.find((r) => r.label.startsWith('100-node'))
    const lastTreeRow = treeRows[treeRows.length - 1]

    return {
      name: this.name,
      title: this.title,
      headline: {
        '100-node page': firstTreeRow?.metrics.mean ?? '—',
        '100-node throughput': `${firstTreeRow?.metrics.pages_per_sec ?? '—'} pages/s`,
        [`largest (${lastTreeRow?.label ?? '—'})`]: lastTreeRow?.metrics.mean ?? '—',
      },
      sections: [
        {
          title: 'Tree-size scaling',
          intro: 'How HTML render cost scales with page node count. Approximately linear in the number of nodes.',
          rows: treeRows,
        },
        {
          title: 'Per-node class application',
          intro:
            'Each row applies N class IDs to every node in a 500-node tree, with M classes defined site-wide. Tests whether class lookups become the bottleneck.',
          rows: classRows,
        },
        {
          title: 'Site CSS bundle build',
          intro:
            'Cost of building one page’s CSS as the reusable class catalog grows. Published reset/framework files share a version memo; authored CSS is selected per page and served under content-hashed, immutable URLs.',
          rows: cssRows,
        },
      ],
    }
  },
}
