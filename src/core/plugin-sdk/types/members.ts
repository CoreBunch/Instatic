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
