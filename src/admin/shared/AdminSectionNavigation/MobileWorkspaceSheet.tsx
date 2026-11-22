import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { AccountMenuButton } from '@admin/shared/AccountMenuButton'
import { BranchChip } from '@admin/shared/BranchSwitcher'
import { OpenLivePageButton } from '@admin/shared/OpenLivePageButton'
import { SettingsButton } from '@site/toolbar/SettingsButton'
import { Button } from '@ui/components/Button'
import { AdminNavLink } from './AdminNavLink'
import type { AdminNavEntry } from './navEntry'
import styles from './MobileWorkspaceSheet.module.css'

interface MobileWorkspaceSheetProps {
  activeLabel: string
  entries: AdminNavEntry[]
  siteName: string | null
  pluginActions: ReactNode
  onNavigate: (to: string) => void
}

export function MobileWorkspaceSheet({
  activeLabel,
  entries,
  siteName,
  pluginActions,
  onNavigate,
}: MobileWorkspaceSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const dragStart = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const titleId = useId()

  function close() {
    dialog.current?.close()
  }

  function closeAfterAction(event: MouseEvent<HTMLElement>) {
    // Portal clicks bubble through React even after the sheet is dismissed.
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (button && event.currentTarget.contains(button)) close()
  }

  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        className={styles.switcher}
        aria-label={`Switch workspace, current workspace: ${activeLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          trigger.current?.focus({ preventScroll: true })
          dialog.current?.showModal()
          setOpen(true)
        }}
      >
        {siteName && <span className={styles.siteName}>{siteName}</span>}
        <span className={styles.current}>
          <span>{activeLabel}</span>
          <ChevronDownIcon size={12} aria-hidden="true" />
        </span>
      </Button>
      <dialog
        ref={dialog}
        className={styles.sheet}
        aria-labelledby={titleId}
        onClose={() => setOpen(Boolean(dialog.current?.open))}
        onClick={(event) => {
          if (event.target === event.currentTarget) close()
        }}
      >
        <div className={styles.surface}>
          <header
            className={styles.heading}
            onPointerDown={(event) => {
              if (event.pointerType === 'mouse' || (event.target instanceof Element && event.target.closest('button'))) return
              dragStart.current = event.clientY
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerUp={(event) => {
              if (dragStart.current !== null && event.clientY - dragStart.current > 48) close()
              dragStart.current = null
            }}
            onPointerCancel={() => { dragStart.current = null }}
          >
            <h2 id={titleId}>Workspaces</h2>
            <Button variant="ghost" iconOnly aria-label="Close workspaces" onClick={close}>
              <CloseIcon size={16} aria-hidden="true" />
            </Button>
          </header>
          <div className={styles.items}>
            <nav aria-label="Admin sections" className={styles.grid}>
              {entries.map((entry) => (
                <AdminNavLink
                  key={entry.key}
                  entry={entry}
                  className={styles.tile}
                  onNavigate={(to) => {
                    close()
                    if (!entry.active) onNavigate(to)
                  }}
                >
                  {entry.icon}
                  <span>{entry.label}</span>
                  {entry.badge}
                  {entry.active && <CheckIcon className={styles.check} size={12} aria-hidden="true" />}
                </AdminNavLink>
              ))}
            </nav>
            <div className={styles.commands} onClick={closeAfterAction}>{pluginActions}</div>
          </div>
          <footer className={styles.tools} onClick={closeAfterAction}>
            <SettingsButton labeled />
            <AccountMenuButton sheetAnchor={trigger} />
            <BranchChip sheetAnchor={trigger} />
            <OpenLivePageButton labeled />
          </footer>
        </div>
      </dialog>
    </>
  )
}
