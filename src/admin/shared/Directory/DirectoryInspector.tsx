import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import styles from './Directory.module.css'

const NARROW_DIRECTORY = '(max-width: 900px)'

/** A desktop inspector or a narrow-screen drawer for the selected record. */
export function DirectoryInspector({ id, label, heading, status, onClose, children }: {
  id: string
  label: string
  heading: ReactNode
  status: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_DIRECTORY).matches ?? false)
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_DIRECTORY)
    const update = () => setNarrow(media.matches)
    media?.addEventListener('change', update)
    return () => media?.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    // A filter can reveal a previously selected row while the user is typing.
    // Move focus only when the row itself opened this inspector.
    if (!narrow && document.activeElement?.getAttribute('aria-controls') === id) {
      closeButton.current?.focus({ preventScroll: true })
    }
  }, [id, narrow])

  const panel = (
    <article id={id} aria-label={label} className={styles.inspector}
      onKeyDown={(event) => {
        if (!narrow && event.key === 'Escape' && event.target instanceof Node && event.currentTarget.contains(event.target)) {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <header className={styles.panelHeader}>
        {heading}
        {!narrow && <Button ref={closeButton} variant="ghost" iconOnly aria-label="Close details" onClick={onClose}>
          <CloseIcon size={16} aria-hidden="true" />
        </Button>}
        {status}
      </header>
      {children}
    </article>
  )

  return narrow
    ? <Dialog open title={label} onClose={onClose} className={styles.drawer} bodyClassName={styles.drawerBody}>{panel}</Dialog>
    : panel
}
