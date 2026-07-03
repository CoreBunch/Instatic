/**
 * awarenessState — typed peer-presence layer over the collab provider's
 * y-protocols awareness instance.
 *
 * Every connected editor publishes ONE local presence state (who I am, which
 * doc I'm on, what I have selected, where my pointer is); every peer's state
 * arrives over the same multiplexed socket and renders through
 * `PeerPresenceOverlay`. Peer states cross the wire from other clients, so
 * reads validate with TypeBox before anything touches the UI.
 *
 * Colors are DERIVED — a deterministic HSL hue from the user id — so every
 * editor assigns the same color to the same admin without coordination.
 */
import { useEffect, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import { encodeCollabDocId } from '@core/collab'
import { safeParseValue, Type, type Static } from '@core/utils/typeboxHelpers'
import { useEditorStore } from '@site/store/store'
import {
  collabAwareness,
  onCollabProviderChange,
} from '@site/store/slices/site/collabBinding'

const PointerSchema = Type.Object({
  /** Iframe-viewport coordinates inside the breakpoint frame. */
  x: Type.Number(),
  y: Type.Number(),
  breakpointId: Type.String(),
})

const EditorPresenceSchema = Type.Object({
  user: Type.Object({
    id: Type.String(),
    name: Type.String(),
    color: Type.String(),
    /** Same avatar precedence as everywhere else: upload → Gravatar → initials. */
    avatarUrl: Type.Union([Type.String(), Type.Null()]),
    gravatarHash: Type.Union([Type.String(), Type.Null()]),
  }),
  docId: Type.Union([Type.String(), Type.Null()]),
  selectedNodeIds: Type.Array(Type.String()),
  /** Node id of an active inline text-edit session, or null. */
  editingNodeId: Type.Union([Type.String(), Type.Null()]),
  pointer: Type.Union([PointerSchema, Type.Null()]),
  /** Caret/selection inside the edited node's Y.Text (base64 relative
   * positions — see collab/caretPositions.ts), or null outside a session. */
  textCaret: Type.Union([
    Type.Object({
      nodeId: Type.String(),
      prop: Type.String(),
      anchor: Type.String(),
      head: Type.String(),
    }),
    Type.Null(),
  ]),
})

export type EditorPresence = Static<typeof EditorPresenceSchema>

export interface PeerPresence extends EditorPresence {
  clientId: number
}

/** Deterministic identity color — same admin, same hue, on every editor. */
export function peerColor(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0
  }
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue} 70% 45%)`
}

/** The collab docId of the document currently open in the editor. */
export function activeEditorDocId(state: {
  activeDocument: { kind: string; vcId?: string } | null
  activePageId: string | null
}): string | null {
  if (state.activeDocument?.kind === 'visualComponent' && state.activeDocument.vcId) {
    return encodeCollabDocId({ kind: 'component', rowId: state.activeDocument.vcId })
  }
  return state.activePageId
    ? encodeCollabDocId({ kind: 'page', rowId: state.activePageId })
    : null
}

/**
 * Publish this editor's presence (identity, active doc, selection, inline
 * edit) into awareness. Mount ONCE per editor (CanvasRoot). The pointer field
 * is owned by `publishLocalPointer` (per-frame mousemove) and preserved here.
 */
export function usePublishEditorPresence(
  user: { id: string; name: string; avatarUrl: string | null; gravatarHash: string | null } | null,
): void {
  const userId = user?.id ?? null
  const userName = user?.name ?? null
  const avatarUrl = user?.avatarUrl ?? null
  const gravatarHash = user?.gravatarHash ?? null

  useEffect(() => {
    if (!userId || !userName) return undefined

    const identity = { id: userId, name: userName, color: peerColor(userId), avatarUrl, gravatarHash }
    const publish = (): void => {
      const awareness = collabAwareness()
      if (!awareness) return
      const s = useEditorStore.getState()
      const previous = awareness.getLocalState() as EditorPresence | null
      awareness.setLocalState({
        ...previous,
        user: identity,
        docId: activeEditorDocId(s),
        selectedNodeIds: s.selectedNodeIds,
        editingNodeId: s.activeInlineEdit?.nodeId ?? null,
        pointer: previous?.pointer ?? null,
        // The caret field is OWNED by the per-frame capture
        // (publishLocalTextCaret); preserve it during a session, force-clear
        // it the moment the session ends so no stale caret lingers.
        textCaret: s.activeInlineEdit ? (previous?.textCaret ?? null) : null,
      })
    }

    publish()
    const offProvider = onCollabProviderChange(publish)
    const unsubscribe = useEditorStore.subscribe(
      (s) => `${activeEditorDocId(s)}|${s.selectedNodeIds.join(',')}|${s.activeInlineEdit?.nodeId ?? ''}`,
      publish,
    )
    return () => {
      offProvider()
      unsubscribe()
      collabAwareness()?.setLocalState(null)
    }
  }, [userId, userName, avatarUrl, gravatarHash])
}

/** Update only the caret field of the local presence (per-frame capture). */
export function publishLocalTextCaret(
  caret: EditorPresence['textCaret'],
): void {
  const awareness = collabAwareness()
  if (!awareness || awareness.getLocalState() === null) return
  awareness.setLocalStateField('textCaret', caret)
}

/** Update only the pointer field of the local presence (throttled by callers). */
export function publishLocalPointer(
  pointer: Static<typeof PointerSchema> | null,
): void {
  const awareness = collabAwareness()
  if (!awareness || awareness.getLocalState() === null) return
  awareness.setLocalStateField('pointer', pointer)
}

function readPeerPresences(docId: string | null): PeerPresence[] {
  const awareness = collabAwareness()
  if (!awareness || !docId) return []
  const peers: PeerPresence[] = []
  for (const [clientId, raw] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue
    // Peer states are wire data from other clients — validate, don't trust.
    const result = safeParseValue(EditorPresenceSchema, raw)
    if (!result.ok || result.value.docId !== docId) continue
    peers.push({ clientId, ...result.value })
  }
  return peers
}

/** One entry per USER (an admin with two tabs is one person). */
export interface SitePeer {
  user: EditorPresence['user']
  /** True when at least one of the user's clients is on `localDocId`. */
  onSameDoc: boolean
}

function readSitePeers(localDocId: string | null): SitePeer[] {
  const awareness = collabAwareness()
  if (!awareness) return []
  const byUser = new Map<string, SitePeer>()
  for (const [clientId, raw] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue
    const result = safeParseValue(EditorPresenceSchema, raw)
    if (!result.ok) continue
    const onSameDoc = localDocId !== null && result.value.docId === localDocId
    const existing = byUser.get(result.value.user.id)
    if (existing) {
      existing.onSameDoc = existing.onSameDoc || onSameDoc
    } else {
      byUser.set(result.value.user.id, { user: result.value.user, onSameDoc })
    }
  }
  return [...byUser.values()]
}

function sitePeersKey(peers: SitePeer[]): string {
  return peers
    .map((p) => `${p.user.id}:${p.user.name}:${p.onSameDoc ? 1 : 0}`)
    .sort()
    .join('|')
}

/**
 * Everyone else connected to the site socket, deduped by user — the toolbar
 * avatar stack. Unlike `usePeerPresences`, this is NOT docId-scoped (it
 * answers "who's here", not "what are they touching") and only re-renders
 * when the roster itself changes — pointer moves don't churn it.
 */
export function useSitePeers(localDocId: string | null): SitePeer[] {
  const [peers, setPeers] = useState<SitePeer[]>([])

  useEffect(() => {
    let awareness: Awareness | null = null
    const recompute = (): void => {
      const next = readSitePeers(localDocId)
      setPeers((current) => (sitePeersKey(current) === sitePeersKey(next) ? current : next))
    }
    const attach = (): void => {
      awareness?.off('change', recompute)
      awareness = collabAwareness()
      awareness?.on('change', recompute)
      recompute()
    }
    attach()
    const offProvider = onCollabProviderChange(attach)
    return () => {
      offProvider()
      awareness?.off('change', recompute)
    }
  }, [localDocId])

  return peers
}

/**
 * Live peer presences on `docId` (everyone except the local client).
 *
 * A y-protocols awareness 'change' fires for EVERY peer on EVERY doc — so a
 * peer moving their pointer on another page would otherwise re-render every
 * overlay here. Bail out unless THIS doc's filtered presences actually
 * changed (same pattern as `useSitePeers`). Same-doc pointer moves still
 * re-render — the canvas RAF reads pointer positions from the returned array.
 */
export function usePeerPresences(docId: string | null): PeerPresence[] {
  const [peers, setPeers] = useState<PeerPresence[]>([])

  useEffect(() => {
    let awareness: Awareness | null = null
    const recompute = (): void => {
      const next = readPeerPresences(docId)
      setPeers((current) =>
        peerPresencesKey(current) === peerPresencesKey(next) ? current : next,
      )
    }
    const attach = (): void => {
      awareness?.off('change', recompute)
      awareness = collabAwareness()
      awareness?.on('change', recompute)
      recompute()
    }
    attach()
    const offProvider = onCollabProviderChange(attach)
    return () => {
      offProvider()
      awareness?.off('change', recompute)
    }
  }, [docId])

  return peers
}

/** Structural key over this doc's presences — includes pointer + caret so the
 *  canvas RAF still sees same-doc moves, but a change on ANOTHER doc is a
 *  no-op here. */
function peerPresencesKey(peers: PeerPresence[]): string {
  return peers
    .map(
      (p) =>
        `${p.clientId}:${p.selectedNodeIds.join(',')}:${p.editingNodeId ?? ''}:` +
        `${p.pointer ? `${p.pointer.x},${p.pointer.y},${p.pointer.breakpointId}` : ''}:` +
        `${p.textCaret ? `${p.textCaret.nodeId},${p.textCaret.anchor},${p.textCaret.head}` : ''}`,
    )
    .sort()
    .join('|')
}
