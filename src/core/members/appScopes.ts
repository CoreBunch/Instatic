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

/**
 * Text someone else supplied, made safe to show beside the Allow button: one
 * line, no control or invisible formatting characters (which can reorder or
 * hide text).
 */
export function plainLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Whether a plugin's description of its scope repeats the words of a
 * built-in scope (compared as a member sees it, ignoring letter case), alone
 * or inside a longer text. Scopes are listed one after another on the
 * approval page, so such a description would read as core's own entry.
 */
export function readsAsBuiltInAppScope(description: string): boolean {
  const shown = plainLine(description).toLowerCase()
  return MEMBER_APP_SCOPES.some((scope) => shown.includes(MEMBER_APP_SCOPE_TEXT[scope].toLowerCase()))
}

/**
 * A plugin scope in the words a member reads before allowing an app. Core's
 * fixed words come first and name the plugin, so whatever the plugin wrote
 * stays visibly its own and cannot read as a separate, built-in entry.
 */
export function pluginAppScopeText(pluginName: string, description: string): string {
  return `Through the plugin ${plainLine(pluginName)}: ${plainLine(description)}`
}

/** A scope as a plugin declares it in its manifest (`appScopes`). */
interface DeclaredAppScope {
  name: string
  description: string
}

export type PluginAppScopeChange = 'new' | 'changed' | 'unchanged' | 'removed'

export interface PluginAppScopeDiffRow extends DeclaredAppScope {
  status: PluginAppScopeChange
  /** For a `changed` scope: the description members allowed it under. */
  was?: string
}

/**
 * What an update does to a plugin's app scopes. A member allowed a scope in
 * the words of its description, so a scope whose description changed no
 * longer means what was allowed: it is `changed`, and with the `removed`
 * ones it is withdrawn at the update (`withdrawnPluginAppScopeNames`).
 * Rows come in the new manifest's order, the removed ones last, carrying the
 * description the member last read.
 */
export function diffPluginAppScopes(
  previous: readonly DeclaredAppScope[],
  next: readonly DeclaredAppScope[],
): PluginAppScopeDiffRow[] {
  const before = new Map(previous.map((scope) => [scope.name, scope.description]))
  const rows: PluginAppScopeDiffRow[] = next.map(({ name, description }) => {
    const scope = { name, description }
    const was = before.get(name)
    if (was === undefined) return { ...scope, status: 'new' }
    if (was === scope.description) return { ...scope, status: 'unchanged' }
    return { ...scope, status: 'changed', was }
  })
  const kept = new Set(next.map((scope) => scope.name))
  for (const scope of previous) {
    if (!kept.has(scope.name)) rows.push({ name: scope.name, description: scope.description, status: 'removed' })
  }
  return rows
}

/** The scope names an update takes away from apps and members: the removed and the reworded. */
export function withdrawnPluginAppScopeNames(
  previous: readonly DeclaredAppScope[],
  next: readonly DeclaredAppScope[],
): string[] {
  return diffPluginAppScopes(previous, next)
    .filter((row) => row.status === 'changed' || row.status === 'removed')
    .map((row) => row.name)
}
