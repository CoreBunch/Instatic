#!/usr/bin/env bun
/**
 * Instatic benchmark suite — CLI orchestrator.
 *
 * Usage:
 *   bun run bench                    # full suite, write .tmp/benchmarks/REPORT.md
 *   bun run bench --only=publisher   # comma-separated subset
 *   bun run bench --skip=plugin      # comma-separated exclusions
 *   bun run bench --quick            # smaller iteration counts (~10x faster)
 *   bun run bench --output=path.md   # override report destination
 *   bun run bench --base-url=URL     # use a running server instead of spawning one
 *   bun run bench --help
 *
 * Each bench lives in `scripts/bench/benches/<name>.ts` and exports a
 * `BenchModule`. Adding a new bench is a one-line registration in
 * `ALL_BENCHES` below.
 *
 * Output:
 *   - A markdown report at `--output` (default `.tmp/benchmarks/REPORT.md`)
 *   - Per-bench logs at `.tmp/benchmarks/<name>.log` for deeper digging
 *   - Stdout: a streaming progress log + a one-line summary per bench
 */
import { resolve, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { renderReport } from './lib/report'
import { log } from './lib/log'
import type { BenchModule, BenchResult, BenchContext } from './lib/types'

import { bundleBench } from './benches/bundle'
import { publisherBench } from './benches/publisher'
import { publishBench } from './benches/publish'
import { editorStoreBench } from './benches/editor-store'
import { httpBench } from './benches/http'
import { dbBench } from './benches/db'
import { pluginBench } from './benches/plugin'
import { footprintBench } from './benches/footprint'
import { healthBench } from './benches/health'
import { browserBench } from './benches/browser'
import { snapshotTokensBench } from './benches/snapshot-tokens'

const REPO_ROOT = resolve(import.meta.dir, '../..')

// `browser` and `snapshot-tokens` are NOT in the default run. `browser` needs
// Chromium and optional INSTATIC_BENCH_ADMIN_EMAIL / INSTATIC_BENCH_ADMIN_PASSWORD
// credentials for authenticated scenarios; `snapshot-tokens` needs ANTHROPIC_API_KEY
// + a seeded .tmp/dev.db and makes network calls to count_tokens. Run them
// explicitly, e.g. `bun run bench --only=snapshot-tokens`.
const DEFAULT_BENCHES: readonly BenchModule[] = [
  bundleBench,
  publisherBench,
  publishBench,
  editorStoreBench,
  httpBench,
  dbBench,
  pluginBench,
  footprintBench,
  healthBench,
]

const ALL_BENCHES: readonly BenchModule[] = [
  ...DEFAULT_BENCHES,
  browserBench,
  snapshotTokensBench,
]

interface CliFlags {
  only: string[] | null
  skip: string[]
  quick: boolean
  output: string
  baseUrl: string | undefined
  help: boolean
  list: boolean
}

function parseArgs(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {
    only: null,
    skip: [],
    quick: false,
    output: resolve(REPO_ROOT, '.tmp/benchmarks/REPORT.md'),
    baseUrl: undefined,
    help: false,
    list: false,
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--list') flags.list = true
    else if (arg === '--quick') flags.quick = true
    else if (arg.startsWith('--only=')) flags.only = arg.slice(7).split(',').filter(Boolean)
    else if (arg.startsWith('--skip=')) flags.skip = arg.slice(7).split(',').filter(Boolean)
    else if (arg.startsWith('--output=')) flags.output = resolve(REPO_ROOT, arg.slice(9))
    else if (arg.startsWith('--base-url=')) flags.baseUrl = arg.slice(11)
    else if (arg.startsWith('--chrome-path=') || arg.startsWith('--trace=')) {
      // Consumed by the browser bench directly (it reads process.argv).
      // Accept here so the orchestrator doesn't warn.
    } else {
      log.warn(`Unknown flag: ${arg} (run with --help for usage)`)
    }
  }
  return flags
}

function printHelp(): void {
  console.log(`
Instatic benchmark suite.

Usage:
  bun run bench [flags]

Flags:
  --only=NAME[,NAME]   Run only the listed benches. (Use this to opt into the
                       browser bench, which is excluded from the default run.)
  --skip=NAME[,NAME]   Run everything except the listed benches.
  --quick              Lower iteration counts (~10x faster, less precise).
  --output=PATH        Override report destination (default .tmp/benchmarks/REPORT.md).
  --base-url=URL       Use an already-running server instead of spawning one.
  --chrome-path=PATH   For the browser bench: path to a Chrome/Chromium/Edge binary.
  --trace=NAME[,NAME]  For the browser bench: wrap the named scenarios in a Playwright
                       trace and write to .tmp/benchmarks/browser-traces/<name>.trace.zip.
                       Pass --trace=ALL for every scenario. Open with
                       \`bunx playwright show-trace <file>\`.
  --list               Print available bench names and exit.
  --help               Show this help.

Available benches:
${ALL_BENCHES.map((b) => {
  const isBrowser = b.name === 'browser'
  return `  ${b.name.padEnd(14)}  ${b.description}${isBrowser ? ' [opt-in]' : ''}`
}).join('\n')}
`)
}

function printList(): void {
  for (const b of ALL_BENCHES) {
    console.log(`${b.name}\t${b.title}`)
  }
}

function selectBenches(flags: CliFlags): BenchModule[] {
  const skip = new Set(flags.skip)
  // Default run excludes the browser bench unless --only explicitly names it
  // (it requires Chrome + an extra 30s). With --only, ALL_BENCHES becomes
  // selectable; with no filter, we restrict to DEFAULT_BENCHES.
  const universe = flags.only ? ALL_BENCHES : DEFAULT_BENCHES
  return universe.filter((b) => {
    if (flags.only && !flags.only.includes(b.name)) return false
    if (skip.has(b.name)) return false
    return true
  })
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.help) {
    printHelp()
    process.exit(0)
  }
  if (flags.list) {
    printList()
    process.exit(0)
  }

  const benches = selectBenches(flags)
  if (benches.length === 0) {
    log.fail('No benches selected.')
    process.exit(1)
  }

  const outputDir = resolve(REPO_ROOT, '.tmp/benchmarks')
  mkdirSync(outputDir, { recursive: true })

  const ctx: BenchContext = {
    outputDir,
    quick: flags.quick,
    baseUrl: flags.baseUrl,
  }

  log.section('Instatic benchmark suite')
  log.detail(`Running ${benches.length} bench${benches.length === 1 ? '' : 'es'}: ${benches.map((b) => b.name).join(', ')}`)
  if (flags.quick) log.detail('Quick mode — reduced iteration counts.')
  if (flags.baseUrl) log.detail(`Targeting external server: ${flags.baseUrl}`)

  const results: BenchResult[] = []
  const suiteStart = performance.now()
  for (const bench of benches) {
    log.section(bench.title)
    const start = performance.now()
    try {
      const result = await bench.run(ctx)
      result.durationMs = performance.now() - start
      results.push(result)
      log.ok(`done in ${(result.durationMs / 1000).toFixed(1)}s`)
    } catch (err) {
      log.fail(`${bench.name} failed: ${(err as Error).message}`)
      results.push({
        name: bench.name,
        title: bench.title,
        headline: { status: 'FAILED' },
        sections: [
          {
            title: 'Failure',
            rows: [
              {
                label: 'error',
                metrics: { message: (err as Error).message },
              },
            ],
          },
        ],
        durationMs: performance.now() - start,
      })
    }
  }

  const suiteWallMs = performance.now() - suiteStart

  // Render report
  const md = renderReport(results, {
    runAt: new Date(),
    durationMs: suiteWallMs,
    host: `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? ''}`.trim(),
    bun: Bun.version,
  })

  mkdirSync(dirname(flags.output), { recursive: true })
  writeFileSync(flags.output, md)
  log.section('Report')
  log.ok(`Wrote ${flags.output} (${md.length.toLocaleString()} chars)`)
  log.detail(`Total wall: ${(suiteWallMs / 1000).toFixed(1)}s across ${results.length} bench(es)`)

  // One-line summary per bench in the console
  console.log('')
  for (const r of results) {
    const top = Object.entries(r.headline)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ')
    console.log(`  ${r.name.padEnd(14)}  ${top}`)
  }
}

main().catch((err) => {
  log.fail(`Fatal: ${(err as Error).stack ?? err}`)
  process.exit(1)
})
