/**
 * Site members for plugins: the people with an account on the published
 * site. See `docs/features/plugin-system.md` → "Site members".
 */
import type { ServerPluginMember } from './routes'

/** A member looked up with `api.cms.members.get`. */
export interface PluginMemberRecord extends ServerPluginMember {
  emailVerified: boolean
  /** `suspended` members cannot sign in. */
  status: 'active' | 'suspended'
  createdAt: string
}

/** Why the site cannot email members right now (see `emailStatus`). */
export type PluginMemberEmailBlocker =
  /** No public address is configured, so a link in an email has no address to point at. */
  | 'public_address_missing'
  /** Outgoing email is off. */
  | 'mail_not_configured'
  /** No connector is set up and the server is not in production, so mail is kept in the admin's Activity, not sent. */
  | 'mail_captured_not_sent'
  /** No published invitation page is chosen in the member settings. */
  | 'invite_page_missing'
  /** No published sign-in-link page or password-reset page is chosen. */
  | 'sign_in_page_missing'

/** A plugin's section of a member's data export. */
export interface PluginMemberExportSection {
  /** Heading for the section; the plugin's name when omitted. */
  title?: string
  /** What the plugin keeps about the member, as JSON; null when omitted. */
  data?: unknown
}

export interface ServerPluginMembersApi {
  /** Look a member up by id or by email address. Requires `members.read`. */
  get: (by: { id: string } | { email: string }) => Promise<PluginMemberRecord | null>
  /**
   * Invite an address: the site emails a single-use link to choose a
   * password. `resent` means the address already had a pending invitation
   * and got a fresh link. Requires `members.write` (and `members.tags` when
   * `tags` is given). Rejects when the address already has an account, or
   * when the site cannot send email.
   */
  invite: (input: { email: string; tags?: string[] }) => Promise<{ memberId: string; outcome: 'invited' | 'resent' }>
  /**
   * The member with this address, created when there is none, and no email
   * sent either way. Matches addresses as members do (trimmed, any letter
   * case). Concurrent calls for one address return the same member, and only
   * one of them reports `created: true`.
   *
   * A created member is `pending`: active, no password, address unconfirmed.
   * They get in with a sign-in link or a password reset (or an invitation),
   * which also confirms the address. An existing member is returned as it is:
   * a suspended one stays suspended. A member an administrator deleted is
   * gone for good, so their address gets a fresh account; listen for
   * `member.deleted` if the plugin must not give one back.
   *
   * `confirmed` says whether the address is proven. An unconfirmed member
   * may be an unfinished sign-up someone else started with this address, so
   * treat its profile as unverified.
   *
   * `tags` are granted from this plugin with no end, except a tag this
   * plugin already grants that member and that is still active, whose grant
   * (and end date) is kept. An expired grant is replaced.
   * Requires `members.write` and `members.read` (and `members.tags` when
   * `tags` is given).
   */
  ensure: (input: { email: string; tags?: string[] }) => Promise<{ member: PluginMemberRecord; created: boolean; confirmed: boolean }>
  /**
   * Whether the site can email members links it starts itself right now
   * (invitations, sign-in links, password resets), and if not, every reason.
   * For a setup check. Requires `members.write`.
   */
  emailStatus: () => Promise<{ canEmail: boolean; reasons: PluginMemberEmailBlocker[] }>
  /**
   * Ids of members deleted since `cursor` (null for the start), oldest
   * deletion first, up to `limit` (default 100, at most 1000). Keep
   * `nextCursor` and pass it next time; it stays put when nothing new was
   * deleted. For catching up on deletions the plugin did not hear as
   * `member.deleted` (it was disabled or not yet installed): call it on
   * activation or from a schedule. Requires `members.read`.
   */
  deletedSince: (cursor: string | null, options?: { limit?: number }) => Promise<{ ids: string[]; nextCursor: string | null }>
  /**
   * Add the plugin's section to a member's data export (the member's own
   * download and the admin's "Download data"). Needs `"memberDataExport":
   * true` in the manifest, so the export names the plugin even while it is
   * not running. Register once, at activation; a second registration throws
   * at once. The provider gets the member id and returns `{ title?, data? }`:
   * `data` is everything the plugin keeps about that member, as JSON (at most
   * 1 MiB and 64 levels deep). `title` defaults to the plugin's name. Plugins
   * are asked together, under one deadline for the whole export; a plugin
   * that is not running, throws, is late or returns anything else is listed
   * as "could not be included" and the export goes on. Requires
   * `members.read`.
   */
  exportProvider: (provider: (memberId: string) => PluginMemberExportSection | Promise<PluginMemberExportSection>) => void
  tags: {
    /**
     * Give a member a tag, optionally until `expiresAt` (an ISO date-time).
     * The grant is recorded as coming from this plugin; granting again moves
     * the end date. Requires `members.tags`.
     */
    grant: (memberId: string, tag: string, options?: { expiresAt?: string | null }) => Promise<void>
    /** Take back a tag this plugin granted. A grant from an administrator or another plugin stays. */
    revoke: (memberId: string, tag: string) => Promise<void>
  }
}

/** Options of a `routes.member.*` registration. */
export interface MemberRouteOptions {
  /** Only members holding this tag reach the handler; others get 403. */
  tag?: string
  /**
   * Also let an app the member signed in to call this route with its access
   * token, when that sign-in carries the scope `plugin:<pluginId>:<scope>`.
   * `scope` must be declared in the manifest's `appScopes`. Without this, a
   * member route answers only the member's own browser. The handler's
   * `ctx.app` says which it is.
   */
  app?: { scope: string }
}
