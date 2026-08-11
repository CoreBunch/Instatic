/**
 * PeerAvatarStack — always-visible "who else is here" indicator for the
 * editor toolbar.
 *
 * One `PeerAvatar` per connected ADMIN (a user with two tabs is one
 * person) — the same identity-ringed avatar the live cursor and the
 * selection tag use, so a person is recognizably the same everywhere.
 * Hover shows the name through the shared Tooltip primitive; peers on a
 * different page/component render dimmed with a "(viewing another page)"
 * hint — presence answers "who's here" site-wide, while the canvas chrome
 * shows "what are they touching" on the current doc.
 *
 * Renders nothing when you're alone.
 */
import { Tooltip } from '@ui/components/Tooltip'
import { useEditorStore } from '@site/store/store'
import { activeEditorDocId, useSitePeers } from '@site/collab/awarenessState'
import { PeerAvatar } from '@site/collab/PeerAvatar'
import styles from './PeerAvatarStack.module.css'

export function PeerAvatarStack() {
  const docId = useEditorStore((s) =>
    activeEditorDocId({ activeDocument: s.activeDocument, activePageId: s.activePageId }),
  )
  const peers = useSitePeers(docId)
  if (peers.length === 0) return null

  return (
    <div className={styles.stack} role="group" aria-label="Admins editing this site">
      {peers.map((peer) => (
        <Tooltip
          key={peer.user.id}
          content={peer.onSameDoc ? peer.user.name : `${peer.user.name} (viewing another page)`}
        >
          <PeerAvatar
            user={peer.user}
            size={22}
            className={styles.stackItem}
            data-elsewhere={peer.onSameDoc ? undefined : 'true'}
          />
        </Tooltip>
      ))}
    </div>
  )
}
