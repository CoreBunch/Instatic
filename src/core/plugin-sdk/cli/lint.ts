/**
 * `instatic-plugin lint` — pre-publish health check for a plugin source tree.
 *
 * Validates the manifest, the declared entrypoints' source files, and (when
 * a `dist/` directory exists) the bundled output. Returns a list of human-
 * readable findings; the CLI prints them and exits non-zero when any
 * finding has severity `error`.
 *
 * Checks performed:
 *   • `instatic-plugin.config.ts` exists, evaluates, default-exports a plugin definition
 *   • Manifest validates against the host's TypeBox schema
 *   • Every entrypoint declared in the manifest has a source file on disk
 *     (or a built artifact in `dist/`)
 *   • Plugin source files in `server/` and `modules/` do not import Node/Bun
 *     primitives (`'node:*'`, `'bun:*'`, `require(`, `process.binding`, …)
 *   • Bundled outputs in `dist/server/index.js` and `dist/modules/index.js`
 *     pass the same scan (catches authors that bypass `instatic-plugin build`)
 *   • If `network.outbound` is requested, `networkAllowedHosts` is non-empty
 *
 * The intent: catch every common authoring mistake BEFORE the developer
 * uploads a zip, so they get a precise error in their terminal instead of
 * a vague "could not install plugin" toast in the admin UI.
 */
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { findSandboxLiterals } from '@core/plugins/sandboxScan'
import { parsePluginManifest } from '@core/plugins/manifest'
import { readPluginDefinition } from './build'
import type { PluginDefinition } from '../builders/definePlugin'

export type LintSeverity = 'error' | 'warning'

export interface LintFinding {
  severity: LintSeverity
  /** Short label shown before the message (e.g. `manifest`, `entrypoint:server`). */
  scope: string
  /** Human-readable description of the problem. */
  message: string
  /** Optional path to the offending file, relative to the plugin source dir. */
  file?: string
}

export interface LintResult {
  pluginId: string
  findings: LintFinding[]
}

const SANDBOXED_ENTRYPOINTS: ReadonlyArray<'server' | 'modules'> = ['server', 'modules']

/**
 * Run all lint checks for a plugin source directory. Throws on a corrupt
 * `instatic-plugin.config.ts`; everything else is reported as a finding so the
 * CLI can list multiple problems in one pass.
 */
export async function lintPlugin(sourceDir: string): Promise<LintResult> {
  const absoluteSource = resolve(sourceDir)
  let definition: PluginDefinition
  try {
    definition = await readPluginDefinition(absoluteSource)
  } catch (err) {
    return {
      pluginId: '<unknown>',
      findings: [{
        severity: 'error',
        scope: 'config',
        message: err instanceof Error ? err.message : String(err),
        file: 'instatic-plugin.config.ts',
      }],
    }
  }

  const manifest = definition.manifest
  const findings: LintFinding[] = []

  // ---- manifest validates against the host's TypeBox schema --------------
  // The SDK builders shape-check the plugin author's input, but the host's
  // install-time `parsePluginManifest` enforces a stricter regex set
  // (keywords, license, URLs, etc). Running it here catches mistakes
  // BEFORE the developer uploads the zip. `definePlugin` already omits
  // undefined optional fields, so the in-memory manifest is the same
  // shape the host parses from the zipped `plugin.json`.
  try {
    parsePluginManifest(manifest)
  } catch (err) {
    findings.push({
      severity: 'error',
      scope: 'manifest',
      message: err instanceof Error ? err.message : String(err),
    })
  }

  // ---- network.outbound + networkAllowedHosts coherence ------------------
  //
  // `networkAllowedHosts` is dual-purpose:
  //   1. Server entrypoint (`network.outbound` permission): gates QuickJS
  //      `fetch()` calls — every URL the sandbox fetches must match an
  //      allowlist entry.
  //   2. Frontend assets (`frontend.assets` permission): the publisher
  //      adds the listed hosts to the page CSP `connect-src` so
  //      visitor-side fetches reach them.
  //
  // Plugins that opt into either permission may declare an allowlist, but
  // an allowlist without either permission has no consumer.

  if (manifest.permissions.includes('network.outbound')) {
    const allowlist = manifest.networkAllowedHosts ?? []
    if (allowlist.length === 0) {
      findings.push({
        severity: 'error',
        scope: 'manifest',
        message:
          'Plugin requests `network.outbound` permission but `networkAllowedHosts` is empty. ' +
          'Outbound HTTP calls will fail with "host not in allowlist". ' +
          'Declare each host the plugin needs (`api.example.com` or `*.example.com`).',
      })
    }
  } else if ((manifest.networkAllowedHosts ?? []).length > 0) {
    const usesFrontend = manifest.permissions.includes('frontend.assets')
    if (!usesFrontend) {
      findings.push({
        severity: 'warning',
        scope: 'manifest',
        message:
          '`networkAllowedHosts` is set but neither `network.outbound` (server) ' +
          'nor `frontend.assets` (browser CSP) is requested. ' +
          'The allowlist will be ignored at install time.',
      })
    }
  }

  // ---- frontend.assets coherence ----------------------------------------
  //
  // Permission ↔ declarations:
  //  - `frontend.assets` permission requires the manifest to actually
  //    declare some assets — otherwise the permission has no consumer
  //    and the consent screen is misleading.
  //  - `frontend.assets[]` declarations require the matching permission
  //    (also enforced at install time; checked here so authors get the
  //    error in their terminal pre-upload).
  const declaredAssets = manifest.frontend?.assets ?? []
  const hasFrontendPermission = manifest.permissions.includes('frontend.assets')
  if (hasFrontendPermission && declaredAssets.length === 0) {
    findings.push({
      severity: 'warning',
      scope: 'manifest',
      message:
        '`frontend.assets` permission is requested but `frontend.assets[]` is empty. ' +
        'Drop the permission or declare at least one asset.',
    })
  }
  if (!hasFrontendPermission && declaredAssets.length > 0) {
    findings.push({
      severity: 'error',
      scope: 'manifest',
      message:
        '`frontend.assets[]` is non-empty but the `frontend.assets` permission is not requested. ' +
        'Add `permissions.frontendAssets` to the plugin permissions list.',
    })
  }
  // Every declared `script` / `style` references a file under `frontend/`;
  // make sure the source exists. The build CLI bundles every `.ts`/`.tsx`
  // file in `frontend/` to `dist/frontend/<name>.js`, so the source we
  // expect is the same path with `.js` swapped for `.ts`/`.tsx`.
  for (const asset of declaredAssets) {
    const ref = asset.kind === 'script'
      ? asset.src
      : asset.kind === 'style'
        ? asset.href
        : null
    if (!ref) continue
    const sourceTs = join(absoluteSource, ref.replace(/\.js$/, '.ts'))
    const sourceTsx = join(absoluteSource, ref.replace(/\.js$/, '.tsx'))
    const builtFile = join(absoluteSource, 'dist', ref)
    if (!existsSync(sourceTs) && !existsSync(sourceTsx) && !existsSync(builtFile)) {
      findings.push({
        severity: 'error',
        scope: 'manifest',
        message:
          `frontend.assets references "${ref}" but no source file was found at ` +
          `"${ref.replace(/\.js$/, '.ts(x)')}" and no built artifact exists yet.`,
        file: ref,
      })
    }
  }

  // ---- entrypoint sources exist on disk ----------------------------------

  const entrypointSources: Array<{ kind: 'server' | 'modules' | 'editor' | 'frontend' | 'admin'; path: string }> = []
  if (await findEntrypointSource(absoluteSource, 'server')) {
    entrypointSources.push({ kind: 'server', path: 'server/' })
  }
  if (definition.modules.length > 0) {
    entrypointSources.push({ kind: 'modules', path: 'modules/' })
    // Same rationale as the editor check below: the built manifest gets
    // `entrypoints.modules` auto-added, which the host rejects without
    // `modules.register`.
    if (!manifest.permissions.includes('modules.register')) {
      findings.push({
        severity: 'error',
        scope: 'manifest',
        message:
          'Canvas modules are defined but the `modules.register` permission is not requested. ' +
          'Add `permissions.modulesRegister`.',
      })
    }
  }
  if (await findEntrypointSource(absoluteSource, 'editor')) {
    entrypointSources.push({ kind: 'editor', path: 'editor/' })
    // `instatic-plugin build` auto-adds `entrypoints.editor` when an
    // `editor/` source exists — but the config manifest validated above
    // doesn't carry that auto-added entrypoint, so the host-side
    // `editor.code` coherence check can't fire here. Re-check explicitly
    // so the author learns about the missing permission pre-upload
    // instead of at install time.
    if (!manifest.permissions.includes('editor.code')) {
      findings.push({
        severity: 'error',
        scope: 'manifest',
        message:
          'An editor entrypoint source exists (`editor/`) but the `editor.code` permission is not requested. ' +
          'Editor entrypoints run unsandboxed in the admin window and require it — add `permissions.editorCode`.',
      })
    }
  }
  if (await findEntrypointSource(absoluteSource, 'frontend')) {
    entrypointSources.push({ kind: 'frontend', path: 'frontend/' })
  }
  for (const page of manifest.adminPages) {
    if (page.content.kind === 'app') {
      const entry = page.content.entry
      // The .js path in the manifest maps to a .tsx/.ts source.
      const found = ['tsx', 'ts'].some((ext) =>
        existsSync(join(absoluteSource, entry.replace(/\.js$/, `.${ext}`))),
      )
      if (!found) {
        findings.push({
          severity: 'error',
          scope: 'manifest',
          message: `Admin page "${page.id}" declares entry "${entry}" but no .tsx/.ts source was found.`,
          file: entry,
        })
      }
    }
  }

  // ---- source files do not reference Node/Bun primitives -----------------

  for (const { kind, path: relDir } of entrypointSources) {
    if (kind !== 'server' && kind !== 'modules') continue
    const sourceDirAbs = join(absoluteSource, relDir)
    if (!existsSync(sourceDirAbs)) continue
    for (const file of walkSources(sourceDirAbs)) {
      const text = await readFile(file, 'utf-8')
      const offenders = findSandboxLiterals(text)
      for (const offender of offenders) {
        findings.push({
          severity: 'error',
          scope: `source:${kind}`,
          message: `references forbidden sandbox literal \`${offender.literal}\` — plugin code can't reach Node/Bun runtime APIs. Use the SDK instead.`,
          file: file.slice(absoluteSource.length + 1),
        })
      }
    }
  }

  // ---- bundled outputs (when `dist/` exists) pass the scan ---------------

  const distDir = join(absoluteSource, 'dist')
  if (existsSync(distDir)) {
    for (const kind of SANDBOXED_ENTRYPOINTS) {
      const bundlePath = join(distDir, kind, 'index.js')
      if (!existsSync(bundlePath)) continue
      const text = await readFile(bundlePath, 'utf-8')
      const offenders = findSandboxLiterals(text)
      for (const offender of offenders) {
        findings.push({
          severity: 'error',
          scope: `bundle:${kind}`,
          message: `bundled output references forbidden sandbox literal \`${offender.literal}\`. Re-run \`instatic-plugin build\` and check imports.`,
          file: `dist/${kind}/index.js`,
        })
      }
    }
  }

  return { pluginId: manifest.id, findings }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function findEntrypointSource(sourceDir: string, basename: string): Promise<boolean> {
  for (const ext of ['tsx', 'ts', 'js', 'mjs']) {
    if (existsSync(join(sourceDir, `${basename}.${ext}`))) return true
    if (existsSync(join(sourceDir, basename, `index.${ext}`))) return true
  }
  return false
}

/**
 * Walk a directory tree, returning absolute paths to every `.ts`/`.tsx`/
 * `.js`/`.mjs` file. Skips `dist/`, `node_modules/`, and dotfile dirs so
 * the scan stays fast on plugin sources that vendor anything.
 */
function* walkSources(dirAbs: string): Generator<string> {
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'dist' || entry.name === 'node_modules') continue
    const fullPath = join(dirAbs, entry.name)
    if (entry.isDirectory()) {
      yield* walkSources(fullPath)
      continue
    }
    if (/\.(?:tsx?|m?js)$/.test(entry.name)) yield fullPath
  }
}
