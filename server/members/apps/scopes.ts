/**
 * The scopes an app can be given on this site right now: the built-in ones,
 * and those the active plugins declare in their manifests (`appScopes`).
 * One list feeds the admin's scope picker, the check when an app is
 * registered or asks to sign in, and the words a member reads on the
 * approval page.
 */
import {
  MEMBER_APP_SCOPES,
  MEMBER_APP_SCOPE_TEXT,
  isMemberAppScope,
  parsePluginAppScope,
  plainLine,
  pluginAppScope,
  pluginAppScopeText,
  type MemberAppScopeOption,
} from '@core/members'
import { hostPlugins } from '../../plugins/host/registry'

export function listAvailableMemberAppScopes(): MemberAppScopeOption[] {
  const options: MemberAppScopeOption[] = MEMBER_APP_SCOPES.map((scope) => ({ scope, text: MEMBER_APP_SCOPE_TEXT[scope] }))
  const plugins = [...hostPlugins.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  for (const { manifest } of plugins) {
    // A scope only does something through a member route, which needs this grant.
    if (!(manifest.grantedPermissions ?? []).includes('members.read')) continue
    for (const declared of manifest.appScopes ?? []) {
      options.push({
        scope: pluginAppScope(manifest.id, declared.name),
        // The plugin's own words end up beside the Allow button.
        text: plainLine(declared.description),
        plugin: { id: manifest.id, name: plainLine(manifest.name) },
      })
    }
  }
  return options
}

export function isAvailableMemberAppScope(scope: string): boolean {
  return listAvailableMemberAppScopes().some((option) => option.scope === scope)
}

/**
 * A scope in the words a member reads. A plugin's scope is introduced by
 * core's own words naming the plugin (`pluginAppScopeText`), so its
 * description cannot pass for a built-in scope or for several entries. A
 * plugin scope whose plugin is gone or no longer offers it has no
 * description left; it is named plainly.
 */
export function memberAppScopeText(scope: string): string {
  if (isMemberAppScope(scope)) return MEMBER_APP_SCOPE_TEXT[scope]
  const found = listAvailableMemberAppScopes().find((option) => option.scope === scope)
  if (found) return found.plugin ? pluginAppScopeText(found.plugin, found.text) : found.text
  const parsed = parsePluginAppScope(scope)
  return parsed ? `Use the plugin ${parsed.pluginId}` : scope
}
