/**
 * Media usage references — what still depends on an asset.
 *
 * Kept apart from `media.ts` (the asset rows themselves): this module answers
 * "who points at this file?", which the deletion path asks before it acts.
 *
 * `media_usage_refs` has existed since the media schema landed but nothing
 * wrote to it, so the library could not tell a decorative upload from an
 * asset something depends on. That gap is how a profile picture — stored as
 * an ordinary library row, with no marker distinguishing it — could be swept
 * into the trash during a tidy-up and purged, silently nulling
 * `users.avatar_media_id` through its `on delete set null` foreign key.
 *
 * `ref_kind` namespaces the source so more can be registered without touching
 * consumers: `user.avatar` here, page nodes and site settings next.
 */
import { type DbClient, placeholder } from '../db/client'

/** A thing that depends on an asset, resolved for display. */
export interface MediaUsageRef {
  assetId: string
  refKind: string
  refId: string
  /** Human-readable, e.g. a person's name for an avatar. Never a raw id. */
  label: string
  /**
   * Set only when the dependency exists on a site branch and NOT on main —
   * the branch's display name, so the warning can say where to look. Stored
   * references (an avatar) belong to no branch and never carry it.
   */
  branchName?: string
}

/**
 * Point a `(kind, id)` pair at an asset, replacing whatever it pointed at
 * before.
 *
 * Deleting first is what makes this a MOVE rather than an accumulation: a
 * user who changes their avatar four times should leave one row, not four,
 * or the fifth deletion would warn about pictures they replaced months ago.
 */
export async function setMediaUsageRef(
  db: DbClient,
  args: { assetId: string | null; refKind: string; refId: string; refPath?: string },
): Promise<void> {
  const refPath = args.refPath ?? ''
  await db`
    delete from media_usage_refs
    where ref_kind = ${args.refKind} and ref_id = ${args.refId} and ref_path = ${refPath}
  `
  if (!args.assetId) return
  await db`
    insert into media_usage_refs (asset_id, ref_kind, ref_id, ref_path)
    values (${args.assetId}, ${args.refKind}, ${args.refId}, ${refPath})
  `
}

/**
 * Which of these assets are still depended on, with something an operator can
 * recognise.
 *
 * Takes a LIST because the question is always asked about a selection — the
 * deletion path needs one round trip, not one per file.
 */
export async function listMediaUsageRefs(
  db: DbClient,
  assetIds: string[],
): Promise<MediaUsageRef[]> {
  if (assetIds.length === 0) return []
  const placeholders = assetIds.map((_, i) => placeholder(db.dialect, i + 1)).join(", ")
  const { rows } = await db.unsafe<{
    asset_id: string
    ref_kind: string
    ref_id: string
    label: string | null
  }>(
    `select r.asset_id, r.ref_kind, r.ref_id,
            case when r.ref_kind = 'user.avatar'
                 then coalesce(nullif(u.display_name, ''), u.email)
                 else null end as label
       from media_usage_refs r
       left join users u on u.id = r.ref_id and r.ref_kind = 'user.avatar'
      where r.asset_id in (${placeholders})`,
    assetIds,
  )
  return rows.map((row) => ({
    assetId: row.asset_id,
    refKind: row.ref_kind,
    refId: row.ref_id,
    label: row.label ?? row.ref_kind,
  }))
}
