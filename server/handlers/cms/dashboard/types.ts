/**
 * Response shapes for every dashboard widget endpoint.
 *
 * Each interface is the on-the-wire JSON payload one `/admin/api/cms/
 * dashboard/<segment>` endpoint returns. The client-side mirrors live in
 * `src/admin/pages/dashboard/hooks/useDashboardStats.ts` — keep them in
 * sync when you change a shape here.
 */
import type { DashboardPagesStats, DashboardPostsStats, DashboardPublishLineupRow, DashboardPublishLineupStats } from '@core/dashboard'
import type { AuditAction } from '../../../repositories/audit'

// ---------------------------------------------------------------------------
// Request context (input, not a response shape)
// ---------------------------------------------------------------------------

/**
 * Request-scoped context passed to every dashboard reader, distinct from the
 * boot-scoped `CmsHandlerOptions`. Carries the viewer's resolved IANA
 * timezone so readers that bin timestamps per calendar day (the posts
 * histogram) bucket into the operator's local day rather than UTC.
 */
export interface DashboardRequestContext {
  timeZone: string
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export type PagesStats = DashboardPagesStats
export type PostsStats = DashboardPostsStats

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface MediaStatsThumb {
  id: string
  publicPath: string
  altText: string
  mimeType: string
  width: number | null
  height: number | null
  variants: Array<{ width: number; height: number; format: string; path: string }>
}

export interface MediaStats {
  count: number
  totalBytes: number
  /**
   * Up to 16 most-recently-uploaded image assets, each with the
   * variant ladder so the dashboard `<Image>` primitive can build a
   * srcset for the mosaic thumbnails.
   */
  latestThumbs: MediaStatsThumb[]
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * Per-plugin row returned to the dashboard. Mirrors `InstalledPlugin`
 * but trimmed to the fields the Plugins widget actually renders —
 * manifest/permissions/settings stay server-side so the payload is small.
 */
export interface PluginsStatsRow {
  id: string
  name: string
  version: string
  /**
   * Coarse health state for the widget's status dot. Computed
   * server-side from `enabled` + `lifecycle_status` so the widget
   * doesn't need to know the matrix.
   */
  state: 'active' | 'disabled' | 'error'
  /**
   * Public URL for the plugin's manifest-declared icon (resolved
   * server-side from `manifest.icon` + `manifest.assetBasePath`).
   * `null` when the plugin omits an icon — the widget renders its
   * fallback plug glyph in that case. Same resolution rule as the
   * Plugins admin page's `PluginCard`.
   */
  iconUrl: string | null
}

export interface PluginsStats {
  total: number
  active: number
  disabled: number
  errored: number
  /** Up to 8 most-recently-installed plugin rows, newest first. */
  rows: PluginsStatsRow[]
}

// ---------------------------------------------------------------------------
// Publish lineup
// ---------------------------------------------------------------------------

export type PublishLineupRow = DashboardPublishLineupRow
export type PublishLineupStats = DashboardPublishLineupStats

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

/**
 * Compact actor record for the Activity widget — the exact slice of
 * fields the shared `<UserAvatar>` primitive needs to render an image
 * (uploaded avatar → Gravatar → initials), plus the strings the
 * widget uses for its `title` tooltip.
 *
 * Shape matches `Pick<CmsCurrentUser, 'avatarUrl' | 'gravatarHash' |
 * 'displayName' | 'email'>` so the widget can pass the object straight
 * to `<UserAvatar user={…} />` without an adapter step.
 *
 * `gravatarHash` is computed server-side from the actor's normalized
 * email (same helper as `server/repositories/users.ts`) so we don't
 * leak the raw email to clients that don't need it.
 */
export interface RecentActivityActor {
  displayName: string
  email: string
  avatarUrl: string | null
  gravatarHash: string
}

/**
 * One row in the dashboard "Activity" widget feed. A flattened,
 * widget-ready projection of `audit_events` — server-side we already
 * know who did what and to which target, so we ship the resolved
 * actor record + targetCode/targetText and the widget just picks a
 * verb per action.
 *
 *   • `actor`         — current display name / email / avatar info
 *     for the actor user, or `null` for system-initiated events
 *     (`actor_user_id is null` in the row). The widget renders a
 *     fallback icon for the null case.
 *   • `targetCode`    — string to render in <code> styling (paths,
 *     plugin ids, slugs). Null when the action has no code-flavoured
 *     target (e.g. "site was published").
 *   • `targetText`    — string to render in plain/em styling (display
 *     names for user/role events, free-form text). Null when no text
 *     target applies.
 *   • `createdAt`     — ISO datetime. The widget formats this as
 *     a short relative label ("2m" / "1h" / "yest.").
 *
 * The widget never reads `metadata` directly — every field it needs
 * has been resolved on the server against the *current* users / tables
 * maps, so a row whose actor user was later deleted still renders
 * with the snapshot label the audit event carried.
 */
export interface RecentActivityEntry {
  id: string
  action: AuditAction
  actor: RecentActivityActor | null
  targetCode: string | null
  targetText: string | null
  createdAt: string
}

export interface RecentActivityStats {
  rows: RecentActivityEntry[]
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Per-category storage breakdown shown by the dashboard Storage widget.
 *
 * There is intentionally **no quota** here — self-hosted Instatic
 * never imposes an artificial disk cap. The widget shows real usage and
 * stretches its breakdown bar to the sum of the segments, so each
 * category reads as a proportion of *total used* rather than of an
 * imaginary plan limit.
 *
 * Media is split into three sub-categories — `imageBytes`, `videoBytes`,
 * and `documentBytes` — so the breakdown bar can tell the operator at a
 * glance whether their disk is mostly photos, video assets, or PDFs /
 * misc downloads. Classification is by `mime_type` prefix; anything
 * that doesn't match `image/*` or `video/*` falls into `documentBytes`
 * (audio, application/*, text/*, fonts, etc.). This is a coarse split
 * by design — the goal is a visual breakdown, not an audit.
 *
 *   • `imageBytes`    — sum of `media_assets.size_bytes` where
 *                        `mime_type like 'image/%'`.
 *   • `videoBytes`    — sum of `media_assets.size_bytes` where
 *                        `mime_type like 'video/%'`.
 *   • `documentBytes` — sum of `media_assets.size_bytes` for everything
 *                        else (audio, PDFs, archives, …). Always
 *                        includes rows whose `mime_type` is NULL.
 *   • `pluginBytes`   — sum of file sizes under `<uploadsDir>/plugins/`,
 *                        i.e. all installed plugin packages on disk.
 *                        `0` when uploads are not configured (tests).
 *   • `databaseBytes` — byte size of the underlying database. For SQLite
 *                        that is the `.db` file plus its `-wal` / `-shm`
 *                        sidecars when present; for Postgres the result
 *                        of `pg_database_size(current_database())`.
 *   • `totalBytes`    — convenience: `image + video + document + plugin +
 *                        database`. The widget formats this as the
 *                        headline stat.
 *   • `dialect`       — which database the host is running on. Surfaced
 *                        in the widget caption ("SQLite" / "Postgres")
 *                        so the operator knows where data lives.
 */
export interface StorageStats {
  imageBytes: number
  videoBytes: number
  documentBytes: number
  pluginBytes: number
  databaseBytes: number
  totalBytes: number
  dialect: 'sqlite' | 'postgres'
}
