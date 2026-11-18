/**
 * What an app that signs a site member in may ask for. Shared by the server
 * (the authorization server checks requests against it) and the admin (the
 * owner picks from it when registering an app).
 *
 * Two kinds of scope exist. The built-in ones below, and the ones a plugin
 * declares in its manifest (`appScopes`), written `plugin:<pluginId>:<name>`:
 * they let an app call that plugin's member routes that opted in.
 */
export const MEMBER_APP_SCOPES = ['profile', 'access'] as const
export type MemberAppScope = (typeof MEMBER_APP_SCOPES)[number]

/** Each built-in scope in the words a member reads on the approval page. */
export const MEMBER_APP_SCOPE_TEXT: Record<MemberAppScope, string> = {
  profile: 'Your name and email address',
  access: 'Which memberships and access you hold',
}

export function isMemberAppScope(value: string): value is MemberAppScope {
  return (MEMBER_APP_SCOPES as readonly string[]).includes(value)
}

/** The `name` half of a plugin scope: lowercase kebab-case, as a plugin writes it in its manifest. */
export const PLUGIN_APP_SCOPE_NAME_PATTERN = '^[a-z][a-z0-9-]{0,39}$'

const PLUGIN_APP_SCOPE = /^plugin:([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+):([a-z][a-z0-9-]{0,39})$/

/** `plugin:<pluginId>:<name>`: the scope that lets an app call that plugin's opted-in member routes. */
export function pluginAppScope(pluginId: string, name: string): string {
  return `plugin:${pluginId}:${name}`
}

/** The plugin and the name a plugin scope stands for, or null when `scope` is not one. */
export function parsePluginAppScope(scope: string): { pluginId: string; name: string } | null {
  const match = PLUGIN_APP_SCOPE.exec(scope)
  return match ? { pluginId: match[1]!, name: match[2]! } : null
}
