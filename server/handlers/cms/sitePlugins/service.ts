/**
 * Site plugin service layer — the transport-independent half of the site
 * plugin surface, shared by the HTTP routes (./index.ts) and the AI
 * `plugin_*` tools (server/ai/tools/plugin/lifecycleTools.ts):
 *
 *   - `listSitePlugins`         — union of draft folders and site-local
 *                                 runtime rows with computed states
 *   - `runSitePluginActivation` — the Build & activate engine. HTTP-free:
 *                                 consent (step-up) stays with the HTTP
 *                                 wrapper; callers that cannot prompt pass
 *                                 `allowGrantChange: false` and surface the
 *                                 `grants-changed` result as an instruction
 *                                 to confirm in the IDE header
 *   - `republishAndSweep`       — the activation/rollback publish coupling
 */
import type { SiteFile } from '@core/files/schemas'
import type { InstalledPlugin, PluginManifest } from '@core/plugin-sdk'
import {
  computeSitePluginContentHash,
  computeSitePluginState,
  contentHashOfVersion,
  deriveSitePluginManifest,
  discoverSitePlugins,
  sitePluginIdFromLocalId,
  type SitePluginSummary,
} from '@core/site-plugins'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import { getDraftSite } from '../../../repositories/site'
import { getInstalledPlugin, listInstalledPlugins } from '../../../repositories/plugins'
import { runPublishFlush } from '../../../publish/publishFlush'
import { republishAllDataRows, republishAllPages } from '../../../publish/republish'
import {
  bumpPublishVersion,
  getPublishVersion,
  withPublishLock,
} from '../../../publish/publishState'
import { buildSitePlugin } from '../../../plugins/sitePlugins/build'
import { sweepSitePluginRevisions } from '../../../plugins/sitePlugins/retention'
import { createKeyedSerializer } from '../../../util/keyedSerial'
import type { CmsHandlerOptions } from '../shared'
import { activatePluginPackageFromDisk } from '../plugins/install'

// ---------------------------------------------------------------------------
// Per-plugin lifecycle lock
// ---------------------------------------------------------------------------

const serializeLifecycle = createKeyedSerializer()

/**
 * Serialize lifecycle transitions (activate, rollback, delete) per local id.
 * Two overlapping activations would otherwise both read the same row
 * version, derive the same next counter, and race the upgrade path — the
 * build below is single-flight on its own, but the read-row → derive →
 * activate window around it was not.
 */
export function withSitePluginLock<T>(localId: string, fn: () => Promise<T>): Promise<T> {
  return serializeLifecycle(localId, fn)
}

// ---------------------------------------------------------------------------
// Draft access
// ---------------------------------------------------------------------------

/**
 * Read the persisted draft's plugin files — flushing the collab relay first
 * so edits still inside the persist debounce window are included ("flush
 * the editor's pending save, then read the persisted draft").
 */
export async function readDraftPluginFiles(db: DbClient): Promise<SiteFile[]> {
  await runPublishFlush()
  const shell = await getDraftSite(db)
  return shell?.files.filter((file) => file.type === 'plugin') ?? []
}

export function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}

// ---------------------------------------------------------------------------
// GET /site-plugins — the list
// ---------------------------------------------------------------------------

export async function listSitePlugins(db: DbClient): Promise<SitePluginSummary[]> {
  const draftFiles = await readDraftPluginFiles(db)
  let discovered: ReturnType<typeof discoverSitePlugins>
  try {
    discovered = discoverSitePlugins(draftFiles)
  } catch (err) {
    // An invalid local id in the draft must not blank the whole list — the
    // offending folder simply can't be discovered until renamed.
    console.error('[site-plugins] draft discovery failed:', err)
    discovered = []
  }
  const draftByLocalId = new Map(discovered.map((plugin) => [plugin.localId, plugin]))

  const rows = (await listInstalledPlugins(db))
    .flatMap((result) => (result.kind === 'ok' ? [result.plugin] : []))
    .filter((plugin) => plugin.source === 'site-local')
  const rowByLocalId = new Map(
    rows.map((plugin) => [plugin.id.replace(/^site\./, ''), plugin]),
  )

  // Union — a deleted folder must never hide a still-running backend.
  const localIds = [...new Set([...draftByLocalId.keys(), ...rowByLocalId.keys()])].sort()

  return localIds.map((localId) => {
    const draft = draftByLocalId.get(localId) ?? null
    const row = rowByLocalId.get(localId) ?? null

    let manifest: PluginManifest | null = null
    let manifestError: string | null = null
    let draftContentHash: string | null = null
    if (draft) {
      draftContentHash = computeSitePluginContentHash(draft.files)
      if (draft.manifestFile?.content) {
        try {
          manifest = deriveSitePluginManifest({
            localId,
            draftManifestJson: draft.manifestFile.content,
            files: draft.files,
            previousVersion: row?.version ?? null,
            contentHash: draftContentHash,
          })
        } catch (err) {
          manifestError = getErrorMessage(err, 'Invalid site plugin manifest')
        }
      } else {
        manifestError = `plugins/${localId}/plugin.json is missing`
      }
    }

    const declared = manifest?.permissions ?? []
    const granted = row?.grantedPermissions ?? []
    const grantsChanged = manifest !== null && row !== null && !sameStringSet(declared, granted)

    const state = computeSitePluginState({
      hasDraftSource: draft !== null,
      row: row
        ? { version: row.version, lifecycleStatus: row.lifecycleStatus, enabled: row.enabled }
        : null,
      manifestError,
      draftContentHash,
      activeContentHash: contentHashOfVersion(row?.version),
      grantsChanged,
    })

    return {
      localId,
      pluginId: sitePluginIdFromLocalId(localId),
      name: manifest?.name ?? row?.name ?? localId,
      state,
      activeVersion: row?.version ?? null,
      hasDraftSource: draft !== null,
      hasModules: Boolean(manifest?.entrypoints?.modules),
      declaredPermissions: declared,
      grantedPermissions: granted,
      newPermissions: declared.filter((permission) => !granted.includes(permission)),
      removedPermissions: granted.filter((permission) => !declared.includes(permission)),
      manifestError,
      lastError: row?.lastError ?? null,
    }
  })
}

// ---------------------------------------------------------------------------
// Activation engine — shared by the HTTP route and the AI `plugin_activate`
// tool. HTTP-free: consent (step-up) stays with the HTTP wrapper; callers
// that cannot prompt (AI tools, MCP) pass `allowGrantChange: false` and
// surface the `grants-changed` result as an instruction to confirm in the
// IDE header.
// ---------------------------------------------------------------------------

export type SitePluginActivationResult =
  | { status: 'ok'; plugin: InstalledPlugin; upgrade?: { fromVersion: string; toVersion: string }; skipped: boolean }
  | { status: 'not-found'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'grants-changed'; newPermissions: string[]; removedPermissions: string[] }
  | { status: 'build-failed'; diagnostics: string[] }
  | { status: 'upgrade-error'; message: string }

export interface SitePluginActivationInput {
  db: DbClient
  options: CmsHandlerOptions
  user: AuthUser
  /** Null for non-HTTP callers — audit rows then omit ip/ua. */
  req: Request | null
  localId: string
  /**
   * Whether a grant-set change may proceed. The HTTP route sets this true
   * only AFTER a successful step-up; tool callers always pass false.
   */
  allowGrantChange: boolean
}

export function runSitePluginActivation(
  input: SitePluginActivationInput,
): Promise<SitePluginActivationResult> {
  return withSitePluginLock(input.localId, () => activateUnlocked(input))
}

async function activateUnlocked(
  input: SitePluginActivationInput,
): Promise<SitePluginActivationResult> {
  const { db, options, user, req, localId, allowGrantChange } = input
  if (!options.uploadsDir) {
    return { status: 'invalid', message: 'Uploads directory is not configured' }
  }
  const draftFiles = await readDraftPluginFiles(db)
  const plugin = discoverSitePlugins(draftFiles).find((entry) => entry.localId === localId)
  if (!plugin) {
    return { status: 'not-found', message: `No site plugin source at plugins/${localId}/` }
  }
  if (!plugin.manifestFile?.content) {
    return { status: 'invalid', message: `plugins/${localId}/plugin.json is missing` }
  }

  const rowResult = await getInstalledPlugin(db, sitePluginIdFromLocalId(localId))
  const row = rowResult?.kind === 'ok' ? rowResult.plugin : null
  const contentHash = computeSitePluginContentHash(plugin.files)

  // Skip when the active revision already matches the draft source.
  if (
    row &&
    row.lifecycleStatus === 'active' &&
    contentHashOfVersion(row.version) === contentHash
  ) {
    return { status: 'ok', plugin: row, skipped: true }
  }

  // Derive BEFORE building: the grant diff decides whether this request is
  // a consent moment — and a manifest error should fail before any
  // bundling work.
  let manifest: PluginManifest
  try {
    manifest = deriveSitePluginManifest({
      localId,
      draftManifestJson: plugin.manifestFile.content,
      files: plugin.files,
      previousVersion: row?.version ?? null,
      contentHash,
    })
  } catch (err) {
    return { status: 'invalid', message: getErrorMessage(err, 'Invalid site plugin manifest') }
  }

  const granted: readonly string[] = row?.grantedPermissions ?? []
  const declared: readonly string[] = manifest.permissions
  const grantsChanged = !row || !sameStringSet(granted, declared)
  if (grantsChanged && !allowGrantChange) {
    return {
      status: 'grants-changed',
      newPermissions: declared.filter((p) => !granted.includes(p)),
      removedPermissions: granted.filter((p) => !declared.includes(p)),
    }
  }

  const built = await buildSitePlugin({
    localId,
    files: plugin.files,
    previousVersion: row?.version ?? null,
    uploadsDir: options.uploadsDir,
    validateOnly: false,
  })
  if (!built.ok) {
    return { status: 'build-failed', diagnostics: built.diagnostics }
  }

  // Grants = declared, in both directions: activation grants exactly what
  // the draft declares, and dropping a permission shrinks the grant.
  const outcome = await activatePluginPackageFromDisk({
    db,
    options,
    user,
    req,
    manifest: built.manifest,
    grantedPermissions: built.manifest.permissions,
    source: 'site-local',
  })
  if (outcome.upgradeError) {
    return { status: 'upgrade-error', message: outcome.upgradeError }
  }

  await republishAndSweep(db, options.uploadsDir, built.manifest)

  return {
    status: 'ok',
    plugin: outcome.plugin,
    ...(outcome.upgrade ? { upgrade: outcome.upgrade } : {}),
    skipped: false,
  }
}

/**
 * Publish coupling (design → "Revision/publish coupling — defined"): baked
 * Layer-A HTML embeds versioned asset URLs, so when the plugin has
 * visitor-facing surfaces the host republishes BEFORE any old revision is
 * garbage-collected — published pages must never reference a deleted
 * revision. Both artefact kinds are re-baked: pages AND entry-template
 * data rows (`/posts/hello`), which a page-only republish would leave
 * pointing at the swept directory. Backend-only plugins skip the republish
 * and sweep immediately.
 */
export async function republishAndSweep(
  db: DbClient,
  uploadsDir: string,
  manifest: PluginManifest,
): Promise<void> {
  const visitorFacing =
    (manifest.frontend?.assets.length ?? 0) > 0 || Boolean(manifest.entrypoints?.modules)
  if (visitorFacing) {
    try {
      // Under the publish lock, with the same version ordering the full
      // publish uses: bake at N+1, then bump. Baking at N and bumping after
      // would stamp every hole shell one version stale.
      await withPublishLock(async () => {
        const nextVersion = getPublishVersion() + 1
        await republishAllPages(db, uploadsDir, nextVersion)
        await republishAllDataRows(db, uploadsDir, nextVersion)
        bumpPublishVersion()
      })
    } catch (err) {
      // A failed republish must not fail the activation — but it must also
      // not trigger the sweep (old revision stays referenced).
      console.error(`[site-plugins] post-activation republish failed for ${manifest.id}:`, err)
      return
    }
  }
  await sweepSitePluginRevisions(uploadsDir, manifest.id, manifest.version)
}
