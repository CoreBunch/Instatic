/**
 * Plugin IDE presence — publishes this IDE session's identity + active file
 * into the shared site-socket awareness, and reads peers back (validated —
 * peer states are wire data).
 *
 * The published state is `EditorPresence`-compatible (identity block checked
 * server-side against the session), so site editors count IDE users in
 * their toolbar roster; the extra `ideFile` field is what IDE peers key on.
 * Character-precise remote carets inside a code buffer ride y-codemirror's
 * own `cursor` awareness field — this module never touches it.
 *
 * Identity is set once per session; the active file is a FIELD update. A
 * whole-state replace on every file switch would drop and re-add this
 * client in every peer's roster (a visible leave + rejoin).
 */
import { useEffect, useState } from 'react'
import { safeParseValue, Type, type Static } from '@core/utils/typeboxHelpers'
import { peerColor } from '@site/collab/awarenessState'
import type { CmsCurrentUser } from '@core/persistence'
import type { IdeCollabSession } from './ideCollab'

const IdePresenceSchema = Type.Object({
  user: Type.Object({
    id: Type.String(),
    name: Type.String(),
    color: Type.String(),
    avatarUrl: Type.Union([Type.String(), Type.Null()]),
    gravatarHash: Type.Union([Type.String(), Type.Null()]),
  }),
  ideFile: Type.Union([
    Type.Object({
      localId: Type.String(),
      fileId: Type.String(),
      path: Type.String(),
    }),
    Type.Null(),
  ]),
})

export type IdePresence = Static<typeof IdePresenceSchema>

export interface IdePeer extends IdePresence {
  clientId: number
}

/** Publish identity + active-file presence for this IDE session. */
export function usePublishIdePresence(
  session: IdeCollabSession | null,
  user: CmsCurrentUser,
  localId: string,
  activeFile: { fileId: string; path: string } | null,
): void {
  useEffect(() => {
    if (!session) return undefined
    const awareness = session.provider.awareness
    const previous: Record<string, unknown> | null = awareness.getLocalState()
    awareness.setLocalState({
      ...previous,
      user: {
        id: user.id,
        name: user.displayName,
        color: peerColor(user.id),
        avatarUrl: user.avatarUrl,
        gravatarHash: user.gravatarHash,
      },
      // EditorPresence-compatible fields so site-editor peers parse us.
      docId: null,
      selectedNodeIds: [],
      editingNodeId: null,
      pointer: null,
      textCaret: null,
      // Keep whatever file the field effect below already published.
      ideFile: previous?.['ideFile'] ?? null,
    })
    return () => {
      awareness.setLocalState(null)
    }
  }, [session, user.id, user.displayName, user.avatarUrl, user.gravatarHash])

  const fileId = activeFile?.fileId ?? null
  const path = activeFile?.path ?? null
  useEffect(() => {
    if (!session) return
    session.provider.awareness.setLocalStateField(
      'ideFile',
      fileId && path ? { localId, fileId, path } : null,
    )
  }, [session, localId, fileId, path])
}

function readIdePeers(session: IdeCollabSession, localId: string): IdePeer[] {
  const awareness = session.provider.awareness
  const peers: IdePeer[] = []
  for (const [clientId, raw] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue
    const result = safeParseValue(IdePresenceSchema, raw)
    if (!result.ok) continue
    if (!result.value.ideFile || result.value.ideFile.localId !== localId) continue
    peers.push({ clientId, ...result.value })
  }
  return peers
}

function peersKey(peers: IdePeer[]): string {
  return peers
    .map((p) => `${p.clientId}:${p.user.id}:${p.ideFile?.fileId ?? ''}`)
    .sort()
    .join('|')
}

/** Peers currently inside THIS plugin's IDE (deduped per client). */
export function useIdePeers(session: IdeCollabSession | null, localId: string): IdePeer[] {
  const [peers, setPeers] = useState<IdePeer[]>([])

  useEffect(() => {
    if (!session) return undefined
    const awareness = session.provider.awareness
    const recompute = (): void => {
      const next = readIdePeers(session, localId)
      setPeers((current) => (peersKey(current) === peersKey(next) ? current : next))
    }
    awareness.on('change', recompute)
    recompute()
    return () => {
      awareness.off('change', recompute)
    }
  }, [session, localId])

  return peers
}
