/**
 * Internal MCP connector for the Claude Code driver.
 *
 * The Claude Code driver spawns the `claude` CLI and points it at Instatic's
 * own MCP server (`/_instatic/mcp`). The CLI authenticates with a bearer token
 * like any external MCP client — so the driver needs to mint one internally,
 * without the HTTP connector API's step-up prompt (this is a server-internal,
 * same-user delegation, not an operator minting a shareable secret).
 *
 * The connector is granted EXACTLY the chatting user's own capabilities, so the
 * spawned CLI can do precisely what the user could through the built-in agent —
 * never more (the privilege floor is satisfied by construction).
 *
 * Token lifecycle: the plaintext is only knowable at mint time (the DB stores a
 * hash), so we cache it in-process, keyed by user. On the first use per server
 * process we revoke any stale internal connectors from earlier boots (their
 * plaintext is unrecoverable, hence unusable) and mint a fresh non-expiring one.
 * A server restart rotates the token.
 */

import type { DbClient } from '../../../db/client'
import type { CoreCapability } from '@core/capabilities'
import { createBearerConnection, listConnectorsForUser, revokeConnector } from './store'
import { generatePersonalAccessToken, hashMcpSecret } from './token'

/** Reserved label marking a connector as driver-owned (not operator-created). */
export const INTERNAL_CONNECTOR_LABEL = 'Claude Code (internal)'

/** userId → plaintext bearer token, for this server process only. */
const tokenByUser = new Map<string, string>()

/** In-flight mint per user, so concurrent turns don't double-mint. */
const inflightByUser = new Map<string, Promise<string>>()

/**
 * Return a usable bearer token for the internal Claude Code connector for
 * `userId`, minting one on first use per process. `capabilities` must be the
 * caller's own capability set — the connector is granted that exact subset.
 */
export async function getInternalConnectorToken(
  db: DbClient,
  userId: string,
  capabilities: readonly CoreCapability[],
): Promise<string> {
  const cached = tokenByUser.get(userId)
  if (cached) return cached

  const inflight = inflightByUser.get(userId)
  if (inflight) return inflight

  const minting = mintForUser(db, userId, capabilities)
    .then((token) => {
      tokenByUser.set(userId, token)
      return token
    })
    .finally(() => {
      inflightByUser.delete(userId)
    })
  inflightByUser.set(userId, minting)
  return minting
}

async function mintForUser(
  db: DbClient,
  userId: string,
  capabilities: readonly CoreCapability[],
): Promise<string> {
  // Revoke stale internal connectors from earlier boots — their plaintext is
  // gone, so they're dead weight — to keep the MCP tab tidy.
  const existing = await listConnectorsForUser(db, userId)
  for (const c of existing) {
    if (c.label === INTERNAL_CONNECTOR_LABEL && c.revokedAt === null) {
      await revokeConnector(db, c.id, userId)
    }
  }

  const token = generatePersonalAccessToken()
  const tokenHash = await hashMcpSecret(token)
  await createBearerConnection(db, {
    userId,
    label: INTERNAL_CONNECTOR_LABEL,
    capabilities,
    tokenHash,
    ttlDays: null, // never expires; rotated on each server restart
  })
  return token
}
