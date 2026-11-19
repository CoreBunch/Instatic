/**
 * Built-in `members.apps` loop source: the apps the signed-in member has
 * signed in to with their account on this site.
 *
 * It is `perVisitor`: every member sees their own list, so the loop is
 * rendered at request time and never cached. A signed-out visitor gets an
 * empty list. The item `id` is the approval's id, which is what the
 * "Disconnect an app" form action takes back.
 */
import type { LoopEntitySource, LoopItem, LoopSourceDb } from '@core/loops/types'
import { isoDate, isoDateOrNull, nowIso } from '@core/utils/isoDate'

export const MEMBER_APPS_SOURCE_ID = 'members.apps'

export interface ConnectedMemberApp {
  /** The approval (grant) this row stands for. */
  id: string
  appId: string
  name: string
  /** What the app called the device it runs on; empty when it gave none. */
  device: string
  connectedAt: string
  lastUsedAt: string | null
}

interface ConnectedAppRow {
  id: string
  app_id: string
  name: string
  device_name: string | null
  created_at: Date | string
  last_used_at: Date | string | null
}

/**
 * A member's live approvals, newest first: not revoked, not run out, and of
 * an app the owner has not removed.
 */
export async function listConnectedMemberApps(
  db: LoopSourceDb,
  memberId: string,
  now: string = nowIso(),
): Promise<ConnectedMemberApp[]> {
  const { rows } = await db<ConnectedAppRow>`
    select g.id, g.app_id, a.name, g.device_name, g.created_at, g.last_used_at
      from member_app_grants g
      join member_apps a on a.id = g.app_id
     where g.member_id = ${memberId}
       and g.revoked_at is null and g.expires_at > ${now}
       and a.deleted_at is null
     order by g.created_at desc, g.id
  `
  return rows.map((row) => ({
    id: row.id,
    appId: row.app_id,
    name: row.name,
    device: row.device_name ?? '',
    connectedAt: isoDate(row.created_at),
    lastUsedAt: isoDateOrNull(row.last_used_at),
  }))
}

/** `2026-11-18T09:30:00.000Z` → `2026-11-18`. */
function dayOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : ''
}

function toLoopItem(app: ConnectedMemberApp): LoopItem {
  return {
    id: app.id,
    fields: {
      id: app.id,
      name: app.name,
      device: app.device,
      connectedOn: dayOf(app.connectedAt),
      connectedAt: app.connectedAt,
      lastUsedOn: dayOf(app.lastUsedAt),
      lastUsedAt: app.lastUsedAt ?? '',
    },
  }
}

const PREVIEW: ConnectedMemberApp[] = [
  { id: 'preview-1', appId: 'preview-app-1', name: 'Desktop app', device: 'MacBook Pro', connectedAt: '2026-01-12T09:30:00.000Z', lastUsedAt: '2026-02-03T16:05:00.000Z' },
  { id: 'preview-2', appId: 'preview-app-2', name: 'Mobile app', device: '', connectedAt: '2026-01-28T18:10:00.000Z', lastUsedAt: null },
]

export const MemberAppsSource: LoopEntitySource = {
  id: MEMBER_APPS_SOURCE_ID,
  label: 'Member’s connected apps',
  description: 'The apps the signed-in member has signed in to with their account. Each member sees their own.',
  perVisitor: true,
  filterSchema: {},
  orderByOptions: [{ id: 'connectedAt', label: 'When it was connected' }],
  fields: [
    { id: 'name', label: 'App name' },
    { id: 'device', label: 'Device name', description: 'What the app called the device it runs on. Empty when it gave none.' },
    { id: 'connectedOn', label: 'Connected on (date)', description: 'The day the member allowed the app, as YYYY-MM-DD.' },
    { id: 'lastUsedOn', label: 'Last used on (date)', description: 'The day the app last used its sign-in, as YYYY-MM-DD. Empty when it has not yet.' },
    { id: 'connectedAt', label: 'Connected at (date and time)' },
    { id: 'lastUsedAt', label: 'Last used at (date and time)' },
    { id: 'id', label: 'Connection id', description: 'What a "Disconnect an app" form sends back to say which app.' },
  ],
  async fetch(ctx) {
    // The signed-in member, as every per-visitor source is told: absent at
    // publish time, null when signed out or in a preview.
    const memberId = ctx.request?.member?.id
    if (!memberId) return { items: [], totalItems: 0 }
    const apps = await listConnectedMemberApps(ctx.db, memberId)
    const ordered = ctx.direction === 'asc' ? [...apps].reverse() : apps
    return {
      items: ordered.slice(ctx.offset, ctx.offset + ctx.limit).map(toLoopItem),
      totalItems: ordered.length,
    }
  },
  preview: (ctx) => PREVIEW.slice(0, ctx.limit).map(toLoopItem),
}
