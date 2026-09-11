/**
 * Collab socket — upgrade gating (session + Origin + write capability) for
 * the co-editing WebSocket. The full two-client convergence round-trip runs
 * in collabRelayIntegration.test.ts against a real Bun.serve.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import * as encoding from 'lib0/encoding'
import { SITE_SOCKET_PATH } from '@core/collab'
import { createCollabRelay, type CollabRelay } from '../../../server/collab/relay'
import {
  handleCollabSocketUpgrade,
  reviewAwarenessUpdate,
  type CollabSocketData,
} from '../../../server/collab/socket'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

let cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

async function setup(): Promise<{ harness: CapabilityTestHarness; relay: CollabRelay; cookie: string }> {
  const harness = await createCapabilityTestHarness()
  cleanups.push(() => harness.cleanup())
  const cookie = await harness.setupOwner()
  const relay = createCollabRelay(harness.db, { persistDebounceMs: 10 })
  cleanups.push(() => relay.destroy())
  return { harness, relay, cookie }
}

/** `cookie`/`origin` are fetch-forbidden constructor headers — set after construction. */
function socketRequest(headers: Record<string, string>): Request {
  const req = new Request(`http://localhost${SITE_SOCKET_PATH}`)
  for (const [name, value] of Object.entries(headers)) req.headers.set(name, value)
  return req
}

function fakeServer(upgradeResult: boolean): {
  upgrade: (req: Request, options: { data: CollabSocketData }) => boolean
  data: () => CollabSocketData | null
} {
  let captured: CollabSocketData | null = null
  return {
    upgrade: (_req, options) => {
      captured = options.data
      return upgradeResult
    },
    data: () => captured,
  }
}

describe('collab socket — upgrade gating', () => {
  it('rejects an unauthenticated handshake with 401 before upgrading', async () => {
    const { harness } = await setup()
    const server = fakeServer(true)
    const res = await handleCollabSocketUpgrade(socketRequest({}), harness.db, server)
    expect(res?.status).toBe(401)
    expect(server.data()).toBeNull()
  })

  it('rejects a cross-origin handshake with 403 (CSWSH defense) even with a valid session', async () => {
    const { harness, cookie } = await setup()
    const server = fakeServer(true)
    const res = await handleCollabSocketUpgrade(
      socketRequest({ cookie, origin: 'https://evil.example' }),
      harness.db,
      server,
    )
    expect(res?.status).toBe(403)
    expect(server.data()).toBeNull()
  })

  it('upgrades an authenticated same-origin handshake with fullSiteWriter resolved from capabilities', async () => {
    const { harness, cookie } = await setup()
    const server = fakeServer(true)
    expect(await handleCollabSocketUpgrade(socketRequest({ cookie }), harness.db, server)).toBeNull()
    // The owner holds every site-write cap, so it skips the per-update guard.
    expect(server.data()?.fullSiteWriter).toBe(true)

    // A partial writer (one category) is NOT a full writer — its frames run
    // through the guard, same path a read-only viewer takes.
    const contentOnly = await harness.createRoleUser({
      name: 'Content Only',
      slug: 'site-content-only',
      capabilities: ['site.read', 'site.content.edit'],
    })
    const contentServer = fakeServer(true)
    expect(
      await handleCollabSocketUpgrade(
        socketRequest({ cookie: contentOnly.cookie }),
        harness.db,
        contentServer,
      ),
    ).toBeNull()
    expect(contentServer.data()?.fullSiteWriter).toBe(false)

    const readOnly = await harness.createRoleUser({
      name: 'Site Viewer',
      slug: 'site-viewer-only',
      capabilities: ['site.read'],
    })
    const readOnlyServer = fakeServer(true)
    expect(
      await handleCollabSocketUpgrade(
        socketRequest({ cookie: readOnly.cookie }),
        harness.db,
        readOnlyServer,
      ),
    ).toBeNull()
    expect(readOnlyServer.data()?.fullSiteWriter).toBe(false)
  })

  it('returns 426 when the request is not an upgradable WebSocket handshake', async () => {
    const { harness, cookie } = await setup()
    const res = await handleCollabSocketUpgrade(socketRequest({ cookie }), harness.db, fakeServer(false))
    expect(res?.status).toBe(426)
  })
})

describe('collab socket — awareness review', () => {
  const identity = {
    id: 'admin-1',
    name: 'Admin One',
    avatarUrl: null,
    gravatarHash: 'hash-1',
  }

  /** Wire-shape an awareness update: varUint count, then per client varUint id, varUint clock, varString stateJSON. */
  function awarenessUpdate(entries: Array<{ clientId: number; state: unknown }>): Uint8Array {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, entries.length)
    for (const entry of entries) {
      encoding.writeVarUint(enc, entry.clientId)
      encoding.writeVarUint(enc, 1)
      encoding.writeVarString(enc, JSON.stringify(entry.state))
    }
    return encoding.toUint8Array(enc)
  }

  const data = () => ({ identity, awarenessClients: new Set<number>([42]) })

  it('accepts the connection owner’s own presence', () => {
    const update = awarenessUpdate([{ clientId: 7, state: { user: identity, docId: null } }])
    expect(reviewAwarenessUpdate(update, data())).toBeNull()
  })

  it('accepts the y-protocols default empty state a fresh client announces', () => {
    // Regression: every Awareness starts with local state {} and broadcasts
    // it on connect before real presence is published — that is protocol
    // chatter, not a malformed frame.
    const update = awarenessUpdate([{ clientId: 7, state: {} }])
    expect(reviewAwarenessUpdate(update, data())).toBeNull()
  })

  it('refuses a non-empty state without a user block as malformed', () => {
    const update = awarenessUpdate([{ clientId: 7, state: { pointer: { x: 1, y: 2 } } }])
    expect(reviewAwarenessUpdate(update, data())).toBe('malformed')
  })

  it('refuses an undecodable payload as malformed', () => {
    expect(reviewAwarenessUpdate(new Uint8Array([255, 255, 255]), data())).toBe('malformed')
  })

  it('refuses presence under another admin’s identity as impersonation', () => {
    const forged = { ...identity, name: 'Someone Else' }
    const update = awarenessUpdate([{ clientId: 7, state: { user: forged } }])
    expect(reviewAwarenessUpdate(update, data())).toBe('impersonation')
  })

  it('refuses clearing a clientID this connection never announced', () => {
    const update = awarenessUpdate([{ clientId: 999, state: null }])
    expect(reviewAwarenessUpdate(update, data())).toBe('foreignClear')
  })

  it('allows clearing a clientID this connection contributed', () => {
    const update = awarenessUpdate([{ clientId: 42, state: null }])
    expect(reviewAwarenessUpdate(update, data())).toBeNull()
  })
})
