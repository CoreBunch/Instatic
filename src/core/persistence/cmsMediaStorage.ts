/**
 * CMS media storage admin client.
 *
 * Backs the `/admin/media/storage` page. Talks to the four endpoints in
 * `server/handlers/cms/mediaStorageAdmin.ts`:
 *
 *   GET    /admin/api/cms/media/storage            — snapshot
 *   POST   /admin/api/cms/media/storage/elect      — elect adapter per role
 *   POST   /admin/api/cms/media/storage/delegate   — elect / clear variant delegate
 *   POST   /admin/api/cms/media/storage/verify/:id — run adapter.verify()
 *
 * Schema-validated envelopes follow the same pattern as `cmsPlugins.ts`:
 * the boundary asserts the outer keys exist, the deep types come back as
 * `unknown` and are cast at the call site. The deep types live in
 * `@core/plugin-sdk` (adapters / delegates) and in this file (the wire
 * shapes for `elections` / `electedDelegate`).
 */

import { Type, type Static } from '@sinclair/typebox'
import type {
  MediaAssetRole,
  MediaStorageServingMode,
  MediaStorageVerifyResult,
} from '@core/plugin-sdk'
import { apiRequest, responseErrorMessage, type FetchLike } from '@core/http'
import { safeParseJson } from '@core/utils/jsonValidate'

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface CmsMediaAdapterSummary {
  id: string
  label: string
  roles: ReadonlyArray<MediaAssetRole>
  servingMode: MediaStorageServingMode
  isBuiltIn: boolean
  cspOrigins: ReadonlyArray<{
    directive: 'img-src' | 'media-src' | 'connect-src'
    origin: string
  }>
}

export interface CmsMediaElection {
  role: MediaAssetRole
  adapterId: string
  electedAt: string
  electedByUserId: string | null
  /**
   * `true` when the adapter is currently registered with the host (the
   * plugin that ships it is installed and enabled). `false` when the
   * row points at an adapter we no longer recognise — the admin UI
   * surfaces this as a warning so the user can re-elect.
   */
  installed: boolean
  /** Number of media_assets rows pinned to this adapter id. */
  assetCount: number
}

export interface CmsMediaVariantDelegateSummary {
  id: string
  pluginId: string
  variantUrlTemplate: string
  widths: ReadonlyArray<number>
  formats: ReadonlyArray<'webp' | 'jpeg' | 'avif'>
}

export interface CmsMediaElectedVariantDelegate {
  delegateId: string
  variantUrlTemplate: string
  widths: ReadonlyArray<number>
  formats: ReadonlyArray<'webp' | 'jpeg' | 'avif'>
  electedAt: string
  electedByUserId: string | null
}

export interface CmsMediaStorageState {
  roles: ReadonlyArray<MediaAssetRole>
  adapters: ReadonlyArray<CmsMediaAdapterSummary>
  elections: ReadonlyArray<CmsMediaElection>
  delegates: ReadonlyArray<CmsMediaVariantDelegateSummary>
  electedDelegate: CmsMediaElectedVariantDelegate | null
  /**
   * Counts of rows / variants still pinned to a non-target adapter for
   * each role. Powers the "Migrate N pending →" affordance in the
   * storage admin panel. `0` means everything is already on the elected
   * adapter (or the role has no assets yet).
   */
  migrationBacklog: {
    original: number
    variant: number
  }
}

export type MigrationRole = 'original' | 'variant'

/**
 * Streamed migration progress event — matches the SSE payloads the
 * server sends from `handleMediaStorageMigrate`. The UI uses these to
 * render a live progress bar + per-asset status; on `done` or `error`
 * the stream completes.
 *
 * Schema is the source of truth; used with `safeParseJson` for every
 * NDJSON frame so malformed frames are silently skipped rather than
 * trusted via a cast.
 */
const CmsMediaMigrationEventSchema = Type.Union([
  Type.Object({ kind: Type.Literal('started'), total: Type.Number(), role: Type.Union([Type.Literal('original'), Type.Literal('variant')]), toAdapterId: Type.String() }),
  Type.Object({ kind: Type.Literal('progress'), id: Type.String(), ok: Type.Boolean(), migrated: Type.Number(), total: Type.Number(), error: Type.Optional(Type.String()) }),
  Type.Object({ kind: Type.Literal('done'), migrated: Type.Number(), failed: Type.Number(), total: Type.Number() }),
  Type.Object({ kind: Type.Literal('error'), message: Type.String() }),
])

export type CmsMediaMigrationEvent = Static<typeof CmsMediaMigrationEventSchema>

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

const StorageStateEnvelope = Type.Object(
  {
    roles: Type.Optional(Type.Array(Type.String())),
    adapters: Type.Optional(Type.Array(Type.Unknown())),
    elections: Type.Optional(Type.Array(Type.Unknown())),
    delegates: Type.Optional(Type.Array(Type.Unknown())),
    electedDelegate: Type.Optional(Type.Union([Type.Null(), Type.Unknown()])),
    migrationBacklog: Type.Optional(
      Type.Object(
        {
          original: Type.Number(),
          variant: Type.Number(),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

const ElectionEnvelope = Type.Object(
  { election: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
)

const DelegateEnvelope = Type.Object(
  { electedDelegate: Type.Optional(Type.Union([Type.Null(), Type.Unknown()])) },
  { additionalProperties: true },
)

const VerifyEnvelope = Type.Object(
  {
    result: Type.Object(
      {
        ok: Type.Boolean(),
        reason: Type.Optional(Type.String()),
        hint: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
)

type StorageStateBody = Static<typeof StorageStateEnvelope>
type VerifyBody = Static<typeof VerifyEnvelope>

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface ClientBase {
  fetchImpl?: FetchLike
  basePath?: string
}

function resolveClient(opts: ClientBase | undefined) {
  return {
    fetchImpl: opts?.fetchImpl ?? globalThis.fetch.bind(globalThis),
    basePath: opts?.basePath ?? '/admin/api/cms',
  }
}

export async function getCmsMediaStorageState(opts?: ClientBase): Promise<CmsMediaStorageState> {
  const { fetchImpl, basePath } = resolveClient(opts)
  const body: StorageStateBody = await apiRequest(`${basePath}/media/storage`, {
    schema: StorageStateEnvelope,
    fetchImpl,
    fallbackMessage: 'Media storage state failed',
  })
  return {
    roles: (body.roles ?? []) as ReadonlyArray<MediaAssetRole>,
    adapters: (body.adapters ?? []) as ReadonlyArray<CmsMediaAdapterSummary>,
    elections: (body.elections ?? []) as ReadonlyArray<CmsMediaElection>,
    delegates: (body.delegates ?? []) as ReadonlyArray<CmsMediaVariantDelegateSummary>,
    electedDelegate: (body.electedDelegate ?? null) as CmsMediaElectedVariantDelegate | null,
    migrationBacklog: {
      original: body.migrationBacklog?.original ?? 0,
      variant: body.migrationBacklog?.variant ?? 0,
    },
  }
}

export async function electCmsMediaAdapter(
  input: { role: MediaAssetRole; adapterId: string },
  opts?: ClientBase,
): Promise<CmsMediaElection> {
  const { fetchImpl, basePath } = resolveClient(opts)
  const body = await apiRequest(`${basePath}/media/storage/elect`, {
    method: 'POST',
    body: input,
    schema: ElectionEnvelope,
    fetchImpl,
    fallbackMessage: 'Media adapter election failed',
  })
  if (!body.election) {
    throw new Error('Media adapter election response was missing the election field')
  }
  return body.election as CmsMediaElection
}

export async function electCmsMediaVariantDelegate(
  input: { delegateId: string | null },
  opts?: ClientBase,
): Promise<CmsMediaElectedVariantDelegate | null> {
  const { fetchImpl, basePath } = resolveClient(opts)
  const body = await apiRequest(`${basePath}/media/storage/delegate`, {
    method: 'POST',
    body: input,
    schema: DelegateEnvelope,
    fetchImpl,
    fallbackMessage: 'Media variant delegate election failed',
  })
  return (body.electedDelegate ?? null) as CmsMediaElectedVariantDelegate | null
}

export async function verifyCmsMediaAdapter(
  adapterId: string,
  opts?: ClientBase,
): Promise<MediaStorageVerifyResult> {
  const { fetchImpl, basePath } = resolveClient(opts)
  const encoded = encodeURIComponent(adapterId)
  const body: VerifyBody = await apiRequest(`${basePath}/media/storage/verify/${encoded}`, {
    method: 'POST',
    schema: VerifyEnvelope,
    fetchImpl,
    fallbackMessage: 'Media adapter verify failed',
  })
  return body.result as MediaStorageVerifyResult
}

// ---------------------------------------------------------------------------
// Migration — SSE-streamed progress
// ---------------------------------------------------------------------------

/**
 * Subset of the parsed SSE protocol — we only need event name + raw data
 * line. Built ad-hoc because EventSource doesn't accept POST + body, and
 * the migration endpoint takes `{ role, toAdapterId }` as its payload.
 *
 * The reader is robust to:
 *   • multi-byte UTF-8 split across chunk boundaries (TextDecoder
 *     `stream: true` handles this)
 *   • chunks containing zero / one / many complete events
 *   • a trailing partial event when the stream ends (discarded — the
 *     server always closes after a `done` or `error`)
 */
function parseSseFrames(buffer: string): { frames: Array<{ event: string; data: string }>; rest: string } {
  const frames: Array<{ event: string; data: string }> = []
  let cursor = 0
  while (true) {
    const boundary = buffer.indexOf('\n\n', cursor)
    if (boundary === -1) break
    const block = buffer.slice(cursor, boundary)
    cursor = boundary + 2
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue // comment / heartbeat
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) continue
    frames.push({ event, data: dataLines.join('\n') })
  }
  return { frames, rest: buffer.slice(cursor) }
}

interface StartMigrationInput {
  role: MigrationRole
  toAdapterId: string
}

interface StartMigrationResult {
  /**
   * AsyncIterable of progress events. Each event corresponds to one SSE
   * frame the server emits. The iterable closes naturally when the
   * server completes (`done` / `error`) or when the caller calls
   * `cancel()` to abort the request.
   */
  events: AsyncIterable<CmsMediaMigrationEvent>
  /** Abort the in-flight stream and release the server's role lock. */
  cancel: () => void
}

/**
 * Start a migration and return an iterable of progress events. The
 * server holds a per-role lock for the duration of the run; cancelling
 * disconnects the stream and releases the lock at the next event boundary.
 *
 * The fetch goes through the shared `ClientBase.fetchImpl` so tests can
 * stub it without touching the global fetch. EventSource isn't usable
 * here because the migration endpoint accepts a JSON body via POST —
 * EventSource is GET-only.
 */
export async function startCmsMediaMigration(
  input: StartMigrationInput,
  opts?: ClientBase,
): Promise<StartMigrationResult> {
  const { fetchImpl, basePath } = resolveClient(opts)
  const controller = new AbortController()

  const res = await fetchImpl(`${basePath}/media/storage/migrate`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: controller.signal,
  })
  if (!res.ok) {
    const message = await responseErrorMessage(res, `Migration failed with ${res.status}`)
    throw new Error(message)
  }
  if (!res.body) {
    throw new Error('Migration response had no body — server may be missing the stream wiring.')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  async function* iterate(): AsyncIterable<CmsMediaMigrationEvent> {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = parseSseFrames(buffer)
        buffer = parsed.rest
        for (const frame of parsed.frames) {
          const result = safeParseJson(frame.data, CmsMediaMigrationEventSchema)
          if (!result.ok) continue // Skip malformed frames silently — the next `done` / `error` event will terminate the stream cleanly.
          const event = result.value
          yield event
          if (event.kind === 'done' || event.kind === 'error') return
        }
      }
    } finally {
      try { await reader.cancel() } catch { /* already cancelled */ }
    }
  }

  return {
    events: iterate(),
    cancel: () => controller.abort(),
  }
}
