/**
 * Server-only connector record. Mirrors the credentials store's split: this
 * type carries `tokenHash` and is NEVER serialised over HTTP. The wire-safe
 * projection is `McpConnectorView` (from `@core/ai`), produced by
 * `toConnectorView` in `./store`.
 */
import type { CoreCapability } from '@core/capabilities'
import type { McpAuthMode, McpConnectorType } from '@core/ai'

export interface McpConnectorRecord {
  readonly id: string
  readonly userId: string
  readonly label: string
  readonly type: McpConnectorType
  readonly authMode: McpAuthMode
  /** One-way hash of the secret. Null is reserved for future OAuth rows. */
  readonly tokenHash: string | null
  readonly capabilities: readonly CoreCapability[]
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
  /**
   * ISO 8601 UTC timestamp when this token expires.
   * Always non-null for tokens created via createConnector.
   * Null for grandfathered rows (pre-migration 019): treated as non-expiring.
   */
  readonly expiresAt: string | null
}
