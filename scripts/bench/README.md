# Benchmark suite

A reusable performance suite for the instatic. Spans both ends of the stack: bundle composition, publisher render speed, the full publish pipeline + public serving, the editor store under class/tree stress, HTTP latency + throughput, SQLite performance, plugin sandbox cost, repo footprint, and code-health snapshot.

Everything writes to `.tmp/benchmarks/` (gitignored). One run produces a single `REPORT.md` plus per-bench logs.

## Quick start

```bash
bun run bench               # full suite, all benches, default iterations
bun run bench --quick       # roughly 10× faster, less precise
bun run bench --help
```

The orchestrator writes `.tmp/benchmarks/REPORT.md` and prints a one-line summary per bench. The report has a top-level **Headline numbers** table (every bench contributes ~3 numbers) followed by deep-dive sections.

## Per-bench shortcuts

```bash
bun run bench:bundle        # just dist/ composition
bun run bench:publisher     # just the page-tree → HTML pipeline
bun run bench:publish       # full publish pipeline + public serving (DB-backed)
bun run bench:editor-store  # editor store mutations + class system stress
bun run bench:http          # HTTP latency + throughput (auto starts a server)
bun run bench:db            # SQLite performance
bun run bench:plugin        # QuickJS sandbox boot / hostCall / dispose
bun run bench:footprint     # repo / node_modules / SLOC stats
bun run bench:health        # fallow + jscpd + madge snapshot
bun run bench:browser       # real Chromium via Playwright — opt-in
bun run bench:browser:install   # one-time Chromium download (~92 MiB)
```

> The `browser` bench is **opt-in** — it isn't part of the default `bun run bench` because it needs Playwright's Chromium (downloaded once via `bun run bench:browser:install`, ~92 MiB) and adds ~10s to the run. Use the shortcut above, or pass `--only=browser`.

Or use `--only=NAME[,NAME]` on the orchestrator:

```bash
bun run bench --only=publisher,editor-store
bun run bench --skip=health,plugin
```

## CLI flags

| Flag | Meaning |
| --- | --- |
| `--only=A,B` | Run only the listed benches |
| `--skip=A,B` | Run everything except the listed benches |
| `--quick` | Lower iteration counts (~10× faster, lower precision) |
| `--output=PATH` | Override report destination (default `.tmp/benchmarks/REPORT.md`) |
| `--base-url=URL` | For HTTP / browser benches: use an already-running server instead of spawning one |
| `--chrome-path=PATH` | For the browser bench: path to a Chrome/Chromium/Edge binary if auto-detection misses |
| `--list` | Print available bench names |
| `--help` | Show the CLI help |

## Prerequisites

- **Bundle bench** requires `dist/` to exist. Run `bun run build` first (or invoke `bun run bench` after a fresh build).
- **HTTP bench** spawns a production server on a free port using SQLite at `.tmp/benchmarks/bench-<port>.db`. If `.tmp/dev.db` is present it's cloned as the seed; otherwise the server boots from empty migrations. No external services required.
- **Plugin bench** boots a fresh QuickJS-WASM context per scenario — no plugin code from disk, just synthetic plugin sources defined in `benches/plugin.ts`.
- **Health bench** shells out to `fallow`, `jscpd`, and `madge` via `bunx`. Add a `--skip=health` if those tools are slow on a particular machine.
- **Browser bench** runs under Playwright with its pinned Chromium. The browser binary is NOT in `bun install` — run `bun run bench:browser:install` once (~92 MiB headless Chromium download). Alternatively, pass `--chrome-path=PATH` to a system Chrome / Chromium / Edge / Brave / Arc. If neither is available the bench self-skips with a clear message rather than crashing the run.

## What each bench measures

### bundle
Reads `dist/` and computes JS/CSS totals (raw / gzip / brotli), the eager first-paint payload (everything `dist/index.html` references), the 12 biggest JS chunks, and the 8 biggest CSS chunks. **No server needed.**

### publisher
Drives `publishPage()` (the core page-tree → HTML/CSS function) against synthetic pages of 1 → 50,000 nodes. Reports mean/p50/p95/p99 latency and pages/sec. Also covers:
- **Per-node class application:** how the renderer reacts when nodes carry 0/5/20 class IDs and the site has 100/1k/10k classes defined site-wide.
- **CSS bundle build:** cost of `buildSiteCssBundle()` as the user-class catalog grows.

This is the *user-facing output speed* — what visitors will see.

### publish
Exercises the FULL publish pipeline and the public serving path against an isolated SQLite DB (the same migrations the production server runs), seeded through the real repositories (`saveDraftSite` + `createDataRow`). Each scenario reports an `unavailable: <reason>` row instead of crashing the suite when seeding fails. Scenarios:
- **Full publish wall time scaling** — `publishDraftSite` over N draft pages of ~150 nodes each (10 / 40; quick 5 / 15), including the snapshot bake and the Layer A artefact write to a tmp uploads dir. Also reports the on-disk SQLite growth (main + WAL) per publish — the snapshot storage amplification.
- **Publish status check** — `getDraftPublishStatus` on the published site: the draft-vs-published comparison the admin UI polls.
- **Warm dynamic-route serving** — repeated `renderPublicResolution` for one published page WITHOUT an uploadsDir, forcing the dynamic path (route resolution + the module-level Layer B LRU). The first call warms the cache; the timed calls are real warm hits.
- **404 probe cost** — `renderPublicResolution` on a missing path plus `getSetupStatus`, modelling what the router pays per unmatched GET.
- **Published row-route lookup** — `getPublishedDataRowByRoute` against a data table with 10,000 published rows (quick 2,000), each with an active version. Sensitive to indexing on the versions join.

Where the `publisher` bench measures the pure render function, this bench measures the whole DB-backed publish + serve lifecycle.

### editor-store
Drives the live Zustand store. **This is the "is the builder laggy at scale?" bench.** Scenarios:
- **Class creation scaling:** `createClass()` 100 → 100,000 times. Per-op p95 should stay flat — climbing means linear scans somewhere in the slice.
- **Class lookup throughput:** `site.classes[id]` random reads. Floor below which any class-related UI rendering must live.
- **Node tree mutations:** `insertNode` / `deleteNode` at 100 / 1k / 5k / 10k node trees.
- **Node-class assignment with huge catalogues:** `addNodeClass` when there are 100k classes defined.
- **Multi-delete:** ONE `deleteNodes(ids)` call removing 500 ids (quick 100) spread across all depths of a 10k-node tree (quick 2k), repeated on 3 fresh trees. The canvas multi-select → Delete path.
- **VC-mode keystroke sweep:** per-keystroke `updateNodeProps` on a text node inside a Visual Component while the site holds 20 pages × 500 nodes (quick 5 × 200). Every VC-mode mutation re-syncs slot instances across all consumer trees, so this answers "does typing inside a VC scale with total site size?".
- **Undo coalescing burst:** a 2,000-keystroke (quick 300) single-prop typing burst on one text node — the Properties-panel path, which folds the whole burst into one undo entry. Reports per-op p95 plus the JSON size of the retained `_historyPast` stack after the burst.

If the numbers stay reasonable here, any actual UI lag is a rendering problem, not a state problem.

### http
Starts a production-mode server on a free port (or uses `--base-url=...`) and benchmarks:
- **Sequential latency:** 100 reqs to `/health`, `/admin`, `/admin/site`, and the biggest first-paint JS/CSS/vendor chunks.
- **Concurrent throughput:** 3,000 reqs at c=1, 4, 16, 64 against `/health`, `/admin`, and the largest static asset.
- **Server resource usage:** boot time + RSS before/after load.

### db
Spins up isolated SQLite DBs (the same migrations the production server runs) and measures:
- **Cold migrations** — full schema drop+recreate
- **Single-row inserts** at 100 / 1k / 10k row counts
- **List queries on populated tables** — count(\*), `select … limit 50`, indexed slug lookup, sequential LIKE scan
- **JSON column round-trip** for small / medium / large `cells_json` payloads (5 → 1000 nodes)

Each scenario uses a fresh DB file so the row counts are comparable.

### plugin
Boots a real QuickJS-WASM context (the same one the production server uses for plugin sandboxing) and measures:
- **Cold VM boot** (`createPluginVm`): includes WASM init + context creation + plugin source eval
- **Lifecycle hook latency** (`runLifecycle('activate')` on a no-op plugin)
- **hostCall roundtrip** — round-trip cost across the JS↔sandbox bridge at 100 / 1k / 10k calls
- **VM dispose** — tear-down cost on plugin deactivation / uninstall

### footprint
Pure static analysis — no I/O, no servers:
- Disk size of `dist/`, `vendor/`, `uploads/`, `.tmp/`
- node_modules total + heaviest 10 packages
- Source line counts by directory; production-vs-test ratio
- 10 largest single source files

### health
Aggregates external static-analysis tools:
- `fallow health` — maintainability score, refactoring targets
- `fallow dead-code` — unused files / exports / types
- `jscpd` — duplication % across `src/`
- `madge --circular` — circular dependency count

Each tool runs in its own subprocess with a generous timeout. If a tool is missing, the row notes "unavailable" rather than crashing the suite.

### browser (opt-in)
Boots the production server, spawns Chromium via Playwright (uses Playwright's pinned chromium-headless-shell — install once with `bun run bench:browser:install`), then runs a battery of cold-load and interactive scenarios. Authenticated admin scenarios run only when `INSTATIC_BENCH_ADMIN_EMAIL` and `INSTATIC_BENCH_ADMIN_PASSWORD` are set; without them the bench records the login-screen load and unauthenticated idle frame stability.

**Cold-load metrics** for the three key entry points:
- `/admin` (login screen, unauthenticated)
- `/admin/dashboard` (authenticated)
- `/admin/site` (authenticated, the heavy visual builder)

For each: total wall, FCP, LCP, DOMContentLoaded, load event, long-task count, Total Blocking Time, bytes transferred, JS heap, and DOM node count.

**Interactive scenarios** — every interaction is wrapped in a `requestAnimationFrame` sampler so we know how many frames the user experiences:
- **Admin route cycle** — navigate dashboard → content → data → site, capture per-route transition latency
- **Idle frame stability** — sit on `/admin/site` for 5s (2s in quick mode), count frames exceeding the 16.67ms 60fps budget. Idle pages should drop 0; high drop rate signals background work churning frames.
- **Spotlight (Cmd+K) churn** — open + close the spotlight N times; mean open / close latency + frame stability
- **Selectors panel toggle** — open + close the side panel N times via its rail tab
- **Class creation via dialog UI** — actually click the "Create selector" button, fill the dialog, submit, repeat. End-to-end UI cost including dialog mount + form submission + state update + close.

This is what answers the user-facing "is the builder laggy?" question with real browser metrics — paint, layout, scripting, blocked frames, dropped animation frames. The `editor-store` bench gives the algorithmic floor; this bench measures what visitors actually feel.

**Per-scenario tracing.** Pass `--trace=NAME[,NAME]` (or `--trace=ALL`) to wrap the named scenarios in a Playwright trace. The artifact lands at `.tmp/benchmarks/browser-traces/<name>.trace.zip`. Open with:
```bash
bunx playwright show-trace .tmp/benchmarks/browser-traces/spotlight-churn.trace.zip
```
You'll get a frame-by-frame scrubber with DOM snapshots, network waterfall, console output, and screenshots — the same Trace Viewer that Playwright test reports use.

**A note on FCP/LCP across navigations.** FCP and LCP only fire reliably on a *cold* document load. Subsequent in-session navigations (e.g. moving from `/admin/dashboard` to `/admin/site`) are served from disk + HTTP cache, complete their DCL in single-digit milliseconds, and the browser does not always fire fresh paint observers for them. For those rows, watch DCL + dom_nodes + heap. The cold `/admin` row is the canonical FCP/LCP number.

**Future scenarios** to layer on: drag interactions on the canvas, programmatic class-creation through the editor store (would need a small dev-only hook to expose the store on `window`), Lighthouse-style INP for interactions, mobile viewport runs, CPU throttling.

### snapshot-tokens (opt-in)
Measures how many tokens the site-editor agent's page **read surface** costs, comparing the two representations of the same page:

- **JSON** — the legacy read surface (deleted): `inspect_page` (full node tree) + `list_classes` (all CSS classes) + `list_tokens` (design tokens), each `JSON.stringify`'d exactly as the old tools emitted them into a `tool_result`. Rebuilt by a local `flattenForBench` that reproduces the deleted `buildPageSnapshot` node/class/token mapping, so this regression guard keeps measuring the surface that `read_page` replaced.
- **read_page** — the live first `read_page` result from `renderAgentPage(...)`, counted as the exact serialized tool payload including `pageInfo`. It contains annotated body HTML with a `uid` on each tag plus page-relevant CSS wrapped in a `<style>` block. The CSS includes framework variables/utilities, font token variables, active-page module CSS, used class rules, applicable ambient selectors, and page-targeted user stylesheets. It omits browser-only `@font-face` blocks, unrelated cross-page ambient selectors, long base64/data URLs, and very long URLs. Oversized pages report `pageInfo.nextPart` so follow-up `read_page({ part })` calls can retrieve the remaining cleaned slices.

Tokens are counted with Anthropic's `count_tokens` endpoint (model-accurate, no SDK) against the **real seeded pages** in `.tmp/dev.db`. The report gives per-page and aggregate JSON-vs-read_page token counts and a ratio, plus fairness/fidelity facts it deliberately surfaces: how many `@media` breakpoint blocks the counted CSS carries, how many nodes got annotated, and how many carry per-node prop overrides that live in the JSON tree but not in the published CSS (responsive styling that flows through included class `@media` blocks is counted on the read_page side).

The HTML read surface has shipped (`read_page` replaced the five legacy JSON tools). This bench now serves as a **regression guard** — confirming the first size-budgeted read remains cheaper than the legacy JSON surface it replaced. It is **opt-in**: it needs `ANTHROPIC_API_KEY` and a seeded dev DB, and it makes one network call per measured string. Run it with:
```bash
ANTHROPIC_API_KEY=sk-... bun run bench --only=snapshot-tokens
```
With no key or no seeded DB it self-skips with an actionable message rather than crashing the suite. Rationale: [`docs/features/agent.md` → Why HTML-native](../../docs/features/agent.md#why-html-native).

## Architecture

```
scripts/bench/
  index.ts                    ← CLI orchestrator, --only/--skip/--quick/--output
  lib/
    types.ts                  ← BenchModule / BenchResult / BenchRow contracts
    server.ts                 ← Production server spawn + lifecycle helpers
    browser.ts                ← Chrome launch + auth + perf-metrics helpers
    stats.ts                  ← Percentiles + formatters (ms, bytes, counts)
    report.ts                 ← Renders BenchResult[] into a markdown report
    log.ts                    ← Colored streaming progress log
  benches/
    bundle.ts                 ← Dist composition
    publisher.ts              ← Page-tree → HTML pipeline
    publish.ts                ← Full publish pipeline + public serving (DB-backed)
    editor-store.ts           ← Class & tree mutation stress
    http.ts                   ← Network latency + throughput
    db.ts                     ← SQLite performance
    plugin.ts                 ← QuickJS sandbox cost
    footprint.ts              ← Disk / SLOC / deps
    health.ts                 ← fallow + jscpd + madge
    browser.ts                ← Real-Chrome paint + frame metrics (opt-in)
```

Each bench exports a single `BenchModule` with `{ name, title, description, run(ctx) }`. The orchestrator runs them in series, captures timing, aggregates results, and renders the report.

### Adding a new bench

1. Create `scripts/bench/benches/<name>.ts` exporting a `BenchModule`.
2. Add it to `ALL_BENCHES` in `scripts/bench/index.ts`.
3. (Optional) Add a `bench:<name>` shortcut to `package.json`.

A bench's `run(ctx)` should return a `BenchResult` with:
- `headline` — 2–4 key-value pairs that bubble up to the top-level summary table.
- `sections` — detailed tables of `BenchRow` entries (each row has `inputs` and `metrics` columns).

Sample minimal bench:
```ts
import type { BenchModule } from '../lib/types'

export const myBench: BenchModule = {
  name: 'my-bench',
  title: 'My benchmark',
  description: 'Does something useful.',
  async run(ctx) {
    // ... measure ...
    return {
      name: this.name,
      title: this.title,
      headline: { 'key metric': '42 ms' },
      sections: [
        {
          title: 'Detailed results',
          rows: [
            { label: 'thing A', metrics: { mean: '0.5ms', p95: '1.2ms' } },
          ],
        },
      ],
    }
  },
}
```

## Output format

`.tmp/benchmarks/REPORT.md` looks like:

```markdown
# Instatic — Benchmark Report

Run at: 2026-05-20T18:55:32.123Z
Host: darwin arm64 Apple M2 Pro
Bun: 1.3.11
Total wall time: 142.3s

## Headline numbers
| Bench | Metric | Value |
| --- | --- | --- |
| Bundle composition | JS total (gz) | 909.8 KB |
|  | Eager (gz) | 209.6 KB |
| Publisher render pipeline | 100-node page | 40.2µs |
...

## Bundle composition
_Ran in 0.3s._

### Totals
| label | files | raw | gzip | brotli |
| --- | --- | --- | --- | --- |
...
```

## What this bench *doesn't* measure

- **Cold network latency to a remote server.** All HTTP benches run against localhost — RTT is the loopback floor. Use `--base-url=https://your-host/` to bench a real deployment, but expect numbers dominated by network rather than server.
- **Concurrent multi-user editor scenarios.** Everything is single-threaded.
- **End-to-end UI interaction storms** (drag-drop of N nodes on the canvas, spotlight churning through 1000 commands, etc.). The browser bench captures cold-load + idle frames; layered interaction scenarios are a natural next step — extend `benches/browser.ts` with `page.mouse.*` / `page.keyboard.*` choreography and instrument with the existing `measureIdleFrameStability` helper.

If you add any of the above, please update this README and add the new module to `ALL_BENCHES` (or `DEFAULT_BENCHES`) in `scripts/bench/index.ts`.
