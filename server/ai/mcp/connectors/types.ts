/**
 * Server-only connector record. Mirrors the credentials store's split: this
 * type carries `tokenHash` and is NEVER serialised over HTTP. The wire-safe
 * projection is `McpConnectionView` (from `@core/ai`), produced by
 * `toConnectionView` in `./store`.
 */
import type { CoreCapability } from '@core/capabilities'
import type { McpAuthMode } from '@core/ai'

export interface McpConnectorRecord {
  readonly id: string
  readonly userId: string
  readonly label: string
  readonly authMode: McpAuthMode
  /** One-way hash of a personal access token. OAuth rows keep this null. */
  readonly tokenHash: string | null
  readonly capabilities: readonly CoreCapability[]
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
  /**
   * ISO 8601 UTC timestamp when this token expires.
   * Always non-null for personal access tokens created via createBearerConnection.
   * Null for grandfathered rows (pre-migration 019): treated as non-expiring.
   */
  readonly expiresAt: string | null
}
