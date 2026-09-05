/**
 * Generate the QuickJS plugin-bootstrap artifacts from typed source.
 *
 * The bootstrap is the JavaScript program evaluated inside every plugin
 * QuickJS-WASM VM before any plugin code runs. The eval boundary is
 * unavoidable — QuickJS has no module loader, so the host hands it a single
 * source string — but the AUTHORING surface must be real, typed, lintable,
 * navigable TypeScript, not a giant untyped template literal.
 *
 * This script bundles the two typed entrypoints —
 *   - `server/plugins/quickjs/bootstrap/src/pluginRuntime.ts`   (full plugin VM)
 *   - `server/plugins/quickjs/bootstrap/src/modulePackRuntime.ts` (module-pack VM)
 * each to a single self-contained IIFE string via `Bun.build`, and emits them
 * as committed artifacts under `server/plugins/quickjs/bootstrap/generated/`.
 * The host reads those constants and evaluates them in the VM
 * (`vm.ts` for the full plugin, `modulePackVm.ts` for module packs).
 *
 * Shared runtime helpers (`src/boundary.ts`) are inlined into each artifact by
 * the bundler — one source-level definition, no divergent inline copies.
 *
 * Internal devs run `bun run bootstrap:sync` after editing anything under
 * `bootstrap/src/`. CI runs the architecture gate
 * `src/__tests__/architecture/plugin-bootstrap-fresh.test.ts`, which rebuilds
 * in memory and fails loudly with "run `bun run bootstrap:sync`" if the
 * committed artifact drifts from its source — mirroring `icons:sync` /
 * `vendor-icons-fresh.test.ts`.
 *
 * Bundler determinism: `Bun.build` output is stable within a Bun minor but is
 * NOT guaranteed bit-identical across minors, so a Bun upgrade can legitimately
 * change the bytes. The expected Bun is pinned by `engines.bun` in package.json
 * (`>=1.4.0 <1.5.0`) and by the `oven/bun:1.4` base image in the Dockerfile. On
 * a deliberate Bun-minor bump, regenerate (`bun run bootstrap:sync`) in the same
 * change so the gate fails only on real source drift, never on a routine
 * upgrade.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SRC_DIR = join(ROOT, 'server/plugins/quickjs/bootstrap/src')
const GENERATED_DIR = join(ROOT, 'server/plugins/quickjs/bootstrap/generated')

interface BootstrapArtifact {
  /** Entry .ts file, relative to SRC_DIR. */
  entry: string
  /** Exported constant name in the generated file. */
  constName: string
  /** Committed output file, relative to GENERATED_DIR. */
  outFile: string
}

const ARTIFACTS: BootstrapArtifact[] = [
  {
    entry: 'pluginRuntime.ts',
    constName: 'PLUGIN_BOOTSTRAP_SOURCE',
    outFile: 'pluginBootstrap.ts',
  },
  {
    entry: 'modulePackRuntime.ts',
    constName: 'MODULE_PACK_BOOTSTRAP_SOURCE',
    outFile: 'modulePackBootstrap.ts',
  },
]

/**
 * Bundle one typed entrypoint to a single IIFE string. `target: 'browser'`
 * keeps the output free of any Node/Bun runtime shim — the QuickJS sandbox is
 * a bare JS engine. Minification is OFF so the committed artifact stays
 * diffable and the build stays deterministic across machines on a given Bun.
 */
async function bundleEntry(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(SRC_DIR, entry)],
    format: 'iife',
    target: 'browser',
    minify: false,
  })
  if (!result.success) {
    const messages = result.logs.map((l) => String(l)).join('\n')
    throw new Error(`[sync-plugin-bootstrap] bundling ${entry} failed:\n${messages}`)
  }
  if (result.outputs.length !== 1) {
    throw new Error(
      `[sync-plugin-bootstrap] expected exactly one output for ${entry}, got ${result.outputs.length}`,
    )
  }
  return await result.outputs[0].text()
}

/**
 * Render the committed `.ts` file content for one artifact. The bundled IIFE
 * is embedded as a JSON-encoded string literal — safe regardless of any
 * backticks, backslashes, or `${}` sequences in the bundled program.
 */
function renderArtifactFile(constName: string, bundled: string): string {
  return (
    `/**\n` +
    ` * GENERATED FILE — DO NOT EDIT.\n` +
    ` *\n` +
    ` * Bundled from server/plugins/quickjs/bootstrap/src/ by\n` +
    ` * scripts/sync-plugin-bootstrap.ts. Regenerate with \`bun run bootstrap:sync\`.\n` +
    ` * The freshness gate (plugin-bootstrap-fresh.test.ts) fails if this drifts.\n` +
    ` */\n\n` +
    `export const ${constName} = ${JSON.stringify(bundled)}\n`
  )
}

/**
 * Build every artifact's committed file content in memory. Shared by the
 * writer (sync mode) and the freshness gate so they can never disagree.
 */
export async function buildBootstrapArtifacts(): Promise<
  Array<{ outFile: string; constName: string; content: string }>
> {
  const out: Array<{ outFile: string; constName: string; content: string }> = []
  for (const artifact of ARTIFACTS) {
    const bundled = await bundleEntry(artifact.entry)
    out.push({
      outFile: artifact.outFile,
      constName: artifact.constName,
      content: renderArtifactFile(artifact.constName, bundled),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const check = process.argv.slice(2).includes('--check')
  const built = await buildBootstrapArtifacts()

  if (check) {
    const stale: string[] = []
    for (const { outFile, content } of built) {
      const path = join(GENERATED_DIR, outFile)
      const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
      if (current !== content) stale.push(outFile)
    }
    if (stale.length > 0) {
      console.error(
        `[bootstrap:check] generated bootstrap is stale:\n` +
          stale.map((f) => `    - generated/${f}`).join('\n') +
          `\n\n  Run \`bun run bootstrap:sync\` to regenerate.\n`,
      )
      return 1
    }
    console.error(`[bootstrap:check] generated bootstrap is fresh (${built.length} artifacts).`)
    return 0
  }

  for (const { outFile, content } of built) {
    writeFileSync(join(GENERATED_DIR, outFile), content)
  }
  console.error(
    `[sync-plugin-bootstrap] wrote ${built.length} artifact(s) to ` +
      `server/plugins/quickjs/bootstrap/generated/.`,
  )
  return 0
}

// Only run when invoked as a script — the freshness test imports
// `buildBootstrapArtifacts` without triggering a write.
if (import.meta.main) {
  process.exit(await main())
}
