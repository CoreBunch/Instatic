/**
 * Who owns an id in a plugin's namespace.
 *
 * Plugin-registered things (loop sources, media adapters, variant delegates)
 * carry ids of the form `<pluginId>.<name>`. Plugin ids are dotted and may
 * nest (`acme.vault` and `acme.vault.x` are both valid), so "starts with my
 * id" does not settle ownership: `acme.vault.x.files` starts with both. The
 * owner is the plugin whose id is the LONGEST dotted prefix of the id.
 */

/** Whether `id` sits in `pluginId`'s namespace by prefix (`<pluginId>.<rest>`). */
export function isInPluginNamespace(id: string, pluginId: string): boolean {
  return id.startsWith(`${pluginId}.`) && id.length > pluginId.length + 1
}

/**
 * Among `pluginIds`, the one that owns `id`: the longest whose namespace
 * contains it. Null when none does.
 */
export function owningPluginId(id: string, pluginIds: Iterable<string>): string | null {
  let owner: string | null = null
  for (const pluginId of pluginIds) {
    if (isInPluginNamespace(id, pluginId) && (owner === null || pluginId.length > owner.length)) owner = pluginId
  }
  return owner
}

/**
 * Whether `claimant` may register `id` when `currentOwner` already holds it.
 * Re-registering its own id replaces it. A plugin with the more specific
 * (longer) namespace takes the id back from one that registered it under a
 * shorter prefix before it was loaded. Anything else is another plugin's id.
 */
export function mayReplaceRegistration(id: string, claimant: string, currentOwner: string): boolean {
  if (claimant === currentOwner) return true
  return isInPluginNamespace(id, claimant) && claimant.length > currentOwner.length
}

/**
 * The id among `others` that nests with `pluginId`: one is a dotted prefix of
 * the other (`acme.vault` and `acme.vault.x`). Null when none does. Two such
 * plugins cannot be installed side by side: every `<pluginId>.<name>` id of
 * the longer one would also sit in the shorter one's namespace.
 */
export function nestedPluginId(pluginId: string, others: Iterable<string>): string | null {
  for (const other of others) {
    if (other === pluginId) continue
    if (isInPluginNamespace(pluginId, other) || isInPluginNamespace(other, pluginId)) return other
  }
  return null
}
