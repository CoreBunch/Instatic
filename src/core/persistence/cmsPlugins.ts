import { Type } from '@sinclair/typebox'
import type {
  CmsPluginsPayload,
  InstalledPlugin,
  PluginManifest,
  PluginPermission,
} from '@core/plugin-sdk'
import { apiRequest, type FetchLike } from '@core/http'
import {
  CmsPluginPackInstallSummarySchema,
  CmsPluginSchedulesResponseEnvelopeSchema,
  CmsPluginScheduleRunOutcomeEnvelopeSchema,
} from './responseSchemas'
import type { CmsPluginPackInstallSummary } from './responseSchemas'

// ---------------------------------------------------------------------------
// Envelope schemas
//
// Same envelope-only strategy as cmsContent.ts: validate the outer keys,
// pass deep types through as unknown, cast at the call site. Surfaced by
// /audit-types — replaces `await res.json() as T` with caller-supplied T.

const PluginsListEnvelope = Type.Object(
  {
    plugins: Type.Optional(Type.Array(Type.Unknown())),
    adminPages: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true },
)

const PluginActionEnvelope = Type.Object(
  {
    plugin: Type.Optional(Type.Unknown()),
    plugins: Type.Optional(Type.Array(Type.Unknown())),
    adminPages: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true },
)

const ManifestEnvelope = Type.Object(
  { manifest: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
)

const PluginSettingsEnvelope = Type.Object(
  {
    schema: Type.Optional(Type.Unknown()),
    settings: Type.Optional(Type.Unknown()),
    secretsNeedingReentry: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
)

function emptyPayload(body: Partial<CmsPluginsPayload>): CmsPluginsPayload {
  return {
    plugins: Array.isArray(body.plugins) ? body.plugins : [],
    adminPages: Array.isArray(body.adminPages) ? body.adminPages : [],
  }
}

export async function listCmsPlugins(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPluginsPayload> {
  const body = await apiRequest(`${basePath}/plugins`, {
    schema: PluginsListEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS plugins request failed',
  })
  return emptyPayload(body as Partial<CmsPluginsPayload>)
}

export async function installCmsPluginManifest(
  manifest: PluginManifest,
  grantedPermissions: PluginPermission[] = [],
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ plugin?: InstalledPlugin } & CmsPluginsPayload> {
  const body = await apiRequest(`${basePath}/plugins`, {
    method: 'POST',
    body:
      grantedPermissions.length > 0
        ? { manifest, grantedPermissions }
        : manifest,
    schema: PluginActionEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS plugin install failed',
  })
  return {
    plugin: body.plugin as InstalledPlugin | undefined,
    ...emptyPayload(body as Partial<CmsPluginsPayload>),
  }
}

export async function inspectCmsPluginPackage(
  file: File,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<PluginManifest> {
  const formData = new FormData()
  formData.set('file', file)
  const body = await apiRequest(`${basePath}/plugins/inspect-package`, {
    method: 'POST',
    body: formData,
    schema: ManifestEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS plugin package inspection failed',
  })
  if (!body.manifest) throw new Error('CMS plugin package inspection response was missing manifest')
  return body.manifest as PluginManifest
}

export async function installCmsPluginPackage(
  file: File,
  grantedPermissions: PluginPermission[],
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ plugin?: InstalledPlugin } & CmsPluginsPayload> {
  const formData = new FormData()
  formData.set('file', file)
  formData.set('grantedPermissions', JSON.stringify(grantedPermissions))

  const body = await apiRequest(`${basePath}/plugins/package`, {
    method: 'POST',
    body: formData,
    schema: PluginActionEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS plugin package install failed',
  })
  return {
    plugin: body.plugin as InstalledPlugin | undefined,
    ...emptyPayload(body as Partial<CmsPluginsPayload>),
  }
}

export async function setCmsPluginEnabled(
  pluginId: string,
  enabled: boolean,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ plugin?: InstalledPlugin } & CmsPluginsPayload> {
  const body = await apiRequest(`${basePath}/plugins/${encodeURIComponent(pluginId)}`, {
    method: 'PATCH',
    body: { enabled },
    schema: PluginActionEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS plugin update failed',
  })
  return {
    plugin: body.plugin as InstalledPlugin | undefined,
    ...emptyPayload(body as Partial<CmsPluginsPayload>),
  }
}

/**
 * DELETE /admin/api/cms/plugins/:id — uninstall a plugin. With `force: true`
 * the server skips the plugin's lifecycle hooks (`deactivate` / `uninstall`)
 * and tears everything down anyway — the escape hatch for a plugin whose
 * uninstall hook throws or whose entry file can no longer load.
 */
export async function removeCmsPlugin(
  pluginId: string,
  force = false,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const query = force ? '?force=true' : ''
  await apiRequest(`${basePath}/plugins/${encodeURIComponent(pluginId)}${query}`, {
    method: 'DELETE',
    fetchImpl,
    fallbackMessage: 'CMS plugin delete failed',
  })
}

/**
 * POST /admin/api/cms/plugins/:id/restart — manually restart a plugin
 * after its worker crashed past the budget. The host resets the per-plugin
 * crash counter, drops historical crash events, terminates any stale
 * worker, then re-loads the entrypoint and runs `activate`. Returns the
 * fresh row + payload so the admin UI can update its state in one round.
 */
export async function restartCmsPlugin(
  pluginId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ plugin?: InstalledPlugin } & CmsPluginsPayload> {
  const body = await apiRequest(`${basePath}/plugins/${encodeURIComponent(pluginId)}/restart`, {
    method: 'POST',
    schema: PluginActionEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS plugin restart failed',
  })
  return {
    plugin: body.plugin as InstalledPlugin | undefined,
    ...emptyPayload(body as Partial<CmsPluginsPayload>),
  }
}

export async function installCmsPluginPack(
  pluginId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPluginPackInstallSummary> {
  return apiRequest(`${basePath}/plugins/${encodeURIComponent(pluginId)}/pack/install`, {
    method: 'POST',
    schema: CmsPluginPackInstallSummarySchema,
    fetchImpl,
    fallbackMessage: 'CMS plugin pack install failed',
  })
}

// ---------------------------------------------------------------------------
// Plugin settings
//
// `GET /admin/api/cms/plugins/:id/settings` returns the declared schema +
// the presented stored values: secret fields surface as `'***'` when an
// encrypted value is stored and `''` when not, and `secretsNeedingReentry`
// lists secret fields whose stored value was encrypted with a different
// master key (rotation — the operator must re-enter them). `PUT` validates
// against the schema and persists; the host requires a fresh step-up window
// for the PUT (see `server/handlers/cms/plugins/index.ts:requiresStepUp`),
// so callers in the admin UI must wrap the update in `runStepUp` to surface
// the password prompt when the window has expired.
// ---------------------------------------------------------------------------

export type PluginSettingsValue = string | number | boolean
export type PluginSettingsRecord = Record<string, PluginSettingsValue>
export type PluginSettingsSchema = NonNullable<PluginManifest['settings']>

interface CmsPluginSettingsResponse {
  schema: PluginSettingsSchema
  settings: PluginSettingsRecord
  secretsNeedingReentry: string[]
}

export async function getCmsPluginSettings(
  pluginId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPluginSettingsResponse> {
  const body = await apiRequest(`${basePath}/plugins/${encodeURIComponent(pluginId)}/settings`, {
    schema: PluginSettingsEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS plugin settings load failed',
  })
  return {
    schema: (body.schema as PluginSettingsSchema | undefined) ?? [],
    settings: (body.settings as PluginSettingsRecord | undefined) ?? {},
    secretsNeedingReentry: body.secretsNeedingReentry ?? [],
  }
}

export async function updateCmsPluginSettings(
  pluginId: string,
  settings: PluginSettingsRecord,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<PluginSettingsRecord> {
  const body = await apiRequest(`${basePath}/plugins/${encodeURIComponent(pluginId)}/settings`, {
    method: 'PUT',
    body: { settings },
    schema: PluginSettingsEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS plugin settings update failed',
  })
  return (body.settings as PluginSettingsRecord | undefined) ?? {}
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

export interface CmsPluginScheduleSummary {
  pluginId: string
  scheduleId: string
  /** Registration state — false once the plugin cancels the schedule or stops registering it. */
  enabled: boolean
  /** Operator/failure intervention — true after admin pause or the consecutive-failure auto-pause. */
  paused: boolean
  cadence: unknown
  overlap: 'skip' | 'queue' | 'parallel'
  maxDurationMs: number
  consecutiveFailures: number
  lastRunAt: string | null
  lastFinishedAt: string | null
  lastStatus: 'ok' | 'error' | 'timeout' | 'never_run'
  lastError: string | null
  lastDurationMs: number | null
  nextRunAt: string
}

export interface CmsPluginScheduleRunSummary {
  id: string
  startedAt: string
  finishedAt: string | null
  status: 'ok' | 'error' | 'timeout' | 'never_run'
  error: string | null
  durationMs: number | null
  triggeredBy: 'tick' | 'run-now'
}

interface CmsPluginSchedulesResponse {
  schedules: CmsPluginScheduleSummary[]
  recent: Record<string, CmsPluginScheduleRunSummary[]>
}

export async function listCmsPluginSchedules(
  pluginId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPluginSchedulesResponse> {
  const body = await apiRequest(`${basePath}/plugins/${encodeURIComponent(pluginId)}/schedules`, {
    schema: CmsPluginSchedulesResponseEnvelopeSchema,
    fetchImpl,
    fallbackMessage: 'CMS plugin schedules list failed',
  })
  return {
    // Deep types: schema uses Type.Unknown() because CmsPluginScheduleSummary
    // has a `cadence: unknown` field; cast after envelope validation.
    schedules: (body.schedules ?? []) as CmsPluginScheduleSummary[],
    recent: (body.recent ?? {}) as Record<string, CmsPluginScheduleRunSummary[]>,
  }
}

export async function runCmsPluginScheduleNow(
  pluginId: string,
  scheduleId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ outcome: { ok: boolean; status: string; error?: string; durationMs: number } }> {
  const url = `${basePath}/plugins/${encodeURIComponent(pluginId)}/schedules/${encodeURIComponent(scheduleId)}/run-now`
  return apiRequest(url, {
    method: 'POST',
    schema: CmsPluginScheduleRunOutcomeEnvelopeSchema,
    fetchImpl,
    fallbackMessage: 'CMS plugin schedule run-now failed',
  })
}

export async function pauseCmsPluginSchedule(
  pluginId: string,
  scheduleId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const url = `${basePath}/plugins/${encodeURIComponent(pluginId)}/schedules/${encodeURIComponent(scheduleId)}/pause`
  await apiRequest(url, { method: 'POST', fetchImpl, fallbackMessage: 'CMS plugin schedule pause failed' })
}

export async function resumeCmsPluginSchedule(
  pluginId: string,
  scheduleId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const url = `${basePath}/plugins/${encodeURIComponent(pluginId)}/schedules/${encodeURIComponent(scheduleId)}/resume`
  await apiRequest(url, { method: 'POST', fetchImpl, fallbackMessage: 'CMS plugin schedule resume failed' })
}
