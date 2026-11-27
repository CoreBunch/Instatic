/**
 * Nested plugin ids — the install-time rule that keeps plugin id namespaces
 * from overlapping.
 */

import { nestedPluginId } from '@core/plugins/namespaceOwnership'
import type { DbClient } from '../db/client'
import { listInstalledPluginIds } from '../repositories/plugins'

/**
 * Two plugins whose ids nest (`acme.vault` and `acme.vault.x`) cannot be
 * installed side by side: everything the longer one registers as
 * `<its-id>.<name>` would also sit inside the shorter one's namespace, and
 * every prefix-based ownership check in the host would be ambiguous. Checked
 * against the INSTALLED plugins, enabled or not. A re-install or upgrade of
 * one of an already-nested pair is not refused: that site keeps working, with
 * the boot warning and the exact owner checks at registration.
 */
export class NestedPluginIdError extends Error {
  constructor(pluginId: string, other: string) {
    super(
      `Plugin "${pluginId}" cannot be installed next to "${other}": one id is a prefix of the other, ` +
        `so their namespaces overlap. Remove "${other}" first, or give this plugin an id that does not nest with it.`,
    )
    this.name = 'NestedPluginIdError'
  }
}

export async function assertNoNestedPluginId(db: DbClient, pluginId: string): Promise<void> {
  const installed = await listInstalledPluginIds(db)
  if (installed.includes(pluginId)) return
  const other = nestedPluginId(pluginId, installed)
  if (other) throw new NestedPluginIdError(pluginId, other)
}
