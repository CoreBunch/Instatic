/**
 * PeerAvatarStack — always-visible "who else is here" indicator for the
 * editor toolbar.
 *
 * One avatar per connected ADMIN (a user with two tabs is one person),
 * colored with the same deterministic identity HSL the canvas presence
 * chrome uses, so the avatar, the selection ring, and the cursor label of
 * one person always match. Peers on a different page/component render
 * dimmed with a "(viewing another page)" hint — presence answers "who's
 * here" site-wide, while the canvas chrome shows "what are they touching"
 * on the current doc.
 *
 * Renders nothing when you're alone.
 */
import type { CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { activeEditorDocId, useSitePeers } from '@site/collab/awarenessState'
import styles from './PeerAvatarStack.module.css'

function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function PeerAvatarStack() {
  const docId = useEditorStore((s) =>
    activeEditorDocId({ activeDocument: s.activeDocument, activePageId: s.activePageId }),
  )
  const peers = useSitePeers(docId)
  if (peers.length === 0) return null

  return (
    <div className={styles.stack} role="group" aria-label="Admins editing this site">
      {peers.map((peer) => (
        <span
          key={peer.user.id}
          className={styles.avatar}
          style={{ '--peer-color': peer.user.color } as CSSProperties}
          data-peer-avatar="true"
          data-elsewhere={peer.onSameDoc ? undefined : 'true'}
          title={peer.onSameDoc ? peer.user.name : `${peer.user.name} (viewing another page)`}
        >
          {initialsOf(peer.user.name)}
        </span>
      ))}
    </div>
  )
}
