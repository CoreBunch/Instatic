/**
 * Site sync-event protocol — the wire shapes of the multi-admin live-pull
 * channel (`GET /admin/api/cms/site-socket`, level B of the live-sync plan).
 *
 * Design rules (from the live-sync plan):
 *   - Events carry **ids + seqs, never row payloads**. They are idempotent
 *     HINTS — the client fetches current rows itself, so a dropped, replayed,
 *     or reordered event can never corrupt state. The seq-cursor delta on
 *     (re)connect is the truth; the socket only makes it prompt.
 *   - One save's rows share that save's seq; delta-synthesized events (sent
 *     in response to `subscribe`) may span many saves, hence per-row seqs.
 *   - `actor` is display-level identity for the awareness UI. Absent on
 *     delta-synthesized events (the originating save is no longer known).
 *
 * The server constructs these events (server/events/siteEvents.ts emits them
 * post-commit from the transactional save); the client validates every
 * incoming frame against `SiteSyncEventSchema` before acting — an unknown or
 * malformed frame is logged and dropped, never applied.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/** The socket endpoint — shared by the server upgrade dispatch and the client hook. */
export const SITE_SOCKET_PATH = '/admin/api/cms/site-socket'

/** The three row-backed site collections that sync per row. */
export const SiteSyncTableSchema = Type.Union([
  Type.Literal('pages'),
  Type.Literal('components'),
  Type.Literal('layouts'),
])
export type SiteSyncTable = Static<typeof SiteSyncTableSchema>

/** Display-level identity of the admin (or connector-driven agent) who saved. */
export const SiteSyncActorSchema = Type.Object({
  userId: Type.Union([Type.String(), Type.Null()]),
  name: Type.String(),
})
export type SiteSyncActor = Static<typeof SiteSyncActorSchema>

const RowsChangedEventSchema = Type.Object({
  kind: Type.Literal('rows-changed'),
  table: SiteSyncTableSchema,
  /** rowId → the seq stamped on that row by the save that changed it. */
  seqs: Type.Record(Type.String(), Type.Number()),
  actor: Type.Optional(SiteSyncActorSchema),
})

const RowsDeletedEventSchema = Type.Object({
  kind: Type.Literal('rows-deleted'),
  table: SiteSyncTableSchema,
  /** rowId → the seq stamped on that row by the save that soft-deleted it. */
  seqs: Type.Record(Type.String(), Type.Number()),
  actor: Type.Optional(SiteSyncActorSchema),
})

const ShellChangedEventSchema = Type.Object({
  kind: Type.Literal('shell-changed'),
  seq: Type.Number(),
  actor: Type.Optional(SiteSyncActorSchema),
})

/** A replace-mode save (import / bootstrap) rewrote the site wholesale. */
const SiteReloadedEventSchema = Type.Object({
  kind: Type.Literal('site-reloaded'),
  seq: Type.Number(),
  actor: Type.Optional(SiteSyncActorSchema),
})

const PublishedEventSchema = Type.Object({
  kind: Type.Literal('published'),
  publishVersion: Type.Number(),
  actor: Type.Optional(SiteSyncActorSchema),
})

export const SiteSyncEventSchema = Type.Union([
  RowsChangedEventSchema,
  RowsDeletedEventSchema,
  ShellChangedEventSchema,
  SiteReloadedEventSchema,
  PublishedEventSchema,
])
export type SiteSyncEvent = Static<typeof SiteSyncEventSchema>

/**
 * The one client→server message: sent on (re)connect with the client's seq
 * cursor. The server replies with delta events synthesized from
 * `rows where seq > cursor` (soft-deleted rows included) plus the shell —
 * which is why a missed live event can never cause drift.
 */
export const SiteSocketSubscribeSchema = Type.Object({
  kind: Type.Literal('subscribe'),
  cursor: Type.Number(),
})
