/**
 * Site plugin build orchestrator — the server frontend of
 * `@core/plugin-build`.
 *
 *   draft SiteFile[]  →  derive manifest  →  materialize temp workspace
 *   →  buildPluginPackage (fail-closed import containment, bundle timeout)
 *   →  package under uploads/plugins/site.<id>/<version>/  (or a throwaway
 *      dir in validate-only mode)
 *
 * Builds are single-flight per localId: a second build queues behind the
 * first and runs against the arguments IT was called with (the caller
 * re-reads the then-current draft before calling).
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SiteFile } from '@core/files/schemas'
import type { PluginManifest } from '@core/plugin-sdk'
import { buildPluginPackage } from '@core/plugin-build'
import {
  computeSitePluginContentHash,
  deriveSitePluginManifest,
  sitePluginFolder,
} from '@core/site-plugins'
import { getErrorMessage } from '@core/utils/errorMessage'
import { createKeyedSerializer } from '../../util/keyedSerial'
import { materializeSitePluginWorkspace } from './workspace'

/**
 * '@instatic/plugin-sdk' resolves to the SDK's inlinable runtime surface
 * (pure data builders — defineModule, control, html, sitePluginRoute) so
 * sandbox/module bundles stay self-contained AND small. Never the full
 * barrel: its TypeBox-backed schema modules weigh hundreds of kB and have
 * tripped bundler tree-shake edge cases when inlined.
 */
const SDK_ENTRY = resolve(import.meta.dir, '../../../src/core/plugin-sdk/inlineRuntime.ts')

/** Pathological inputs must fail fast instead of tying up the server. */
const DEFAULT_BUILD_TIMEOUT_MS = 30_000

export interface SitePluginBuildInput {
  localId: string
  /** Every 'plugin' file under plugins/<localId>/ from the persisted draft. */
  files: readonly SiteFile[]
  /** The currently active generated version, or null on first build. */
  previousVersion: string | null
  /** Uploads root — required unless `validateOnly`. */
  uploadsDir?: string
  /** true = diagnostics only: build into the throwaway workspace, never under uploads. */
  validateOnly: boolean
  /** Override the build timeout (ms). Mainly for tests. */
  buildTimeoutMs?: number
}

export interface SitePluginBuildSuccess {
  ok: true
  manifest: PluginManifest
  contentHash: string
  /** Absolute package dir (absent in validate-only mode). */
  packageDir?: string
  /** Built modules bundle text (validate-only, when the draft declares one) — feeds `Preview in canvas`. */
  modulesBundle?: string
}

export interface SitePluginBuildFailure {
  ok: false
  diagnostics: string[]
}

export type SitePluginBuildResult = SitePluginBuildSuccess | SitePluginBuildFailure

// Single-flight per localId — later builds chain behind earlier ones.
const serializeBuild = createKeyedSerializer()

export function buildSitePlugin(input: SitePluginBuildInput): Promise<SitePluginBuildResult> {
  return serializeBuild(input.localId, () => runBuild(input))
}

async function runBuild(input: SitePluginBuildInput): Promise<SitePluginBuildResult> {
  const contentHash = computeSitePluginContentHash(input.files)

  const manifestFile = input.files.find(
    (f) => f.path === `${sitePluginFolder(input.localId)}plugin.json`,
  )
  if (!manifestFile || typeof manifestFile.content !== 'string') {
    return { ok: false, diagnostics: [`plugins/${input.localId}/plugin.json is missing`] }
  }

  let manifest: PluginManifest
  try {
    manifest = deriveSitePluginManifest({
      localId: input.localId,
      draftManifestJson: manifestFile.content,
      files: input.files,
      previousVersion: input.previousVersion,
      contentHash,
    })
  } catch (err) {
    return { ok: false, diagnostics: [getErrorMessage(err, 'Invalid site plugin manifest')] }
  }

  if (!input.validateOnly && !input.uploadsDir) {
    return { ok: false, diagnostics: ['Uploads directory is not configured'] }
  }

  const workspace = await materializeSitePluginWorkspace(input.localId, input.files)
  try {
    const outputDir = input.validateOnly
      ? join(workspace.rootDir, '.instatic-dist')
      : join(input.uploadsDir!, 'plugins', manifest.id, manifest.version)

    const timeoutMs = input.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`site plugin build timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
    })
    try {
      await Promise.race([
        buildPluginPackage({
          sourceDir: workspace.rootDir,
          outputDir,
          manifest,
          resolve: {
            workspaceRoot: workspace.rootDir,
            bareSpecifiers: { '@instatic/plugin-sdk': SDK_ENTRY },
          },
        }),
        timeout,
      ])
    } finally {
      clearTimeout(timeoutHandle)
    }

    let modulesBundle: string | undefined
    if (input.validateOnly && manifest.entrypoints?.modules) {
      // Read before cleanup — the throwaway workspace is about to vanish.
      modulesBundle = await readFile(join(outputDir, manifest.entrypoints.modules), 'utf8')
    }

    return {
      ok: true,
      manifest,
      contentHash,
      ...(input.validateOnly ? {} : { packageDir: outputDir }),
      ...(modulesBundle !== undefined ? { modulesBundle } : {}),
    }
  } catch (err) {
    // Diagnostics quote bundler paths inside the throwaway workspace —
    // rewrite them to the draft's plugins/<localId>/ paths so the message
    // names the author's file instead of leaking a server temp dir.
    const message = getErrorMessage(err, 'Site plugin build failed')
      .replaceAll(`${workspace.rootDir}/`, sitePluginFolder(input.localId))
      .replaceAll(workspace.rootDir, sitePluginFolder(input.localId))
    return { ok: false, diagnostics: [message] }
  } finally {
    await workspace.cleanup()
  }
}
