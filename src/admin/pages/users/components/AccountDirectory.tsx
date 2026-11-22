import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { Button } from '@ui/components/Button'
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableRow } from '@ui/components/DataTable'
import { Dialog } from '@ui/components/Dialog'
import { SkeletonRows } from '@ui/components/Skeleton'
import styles from './AccountDirectory.module.css'

interface DirectoryAccount {
  id: string
  name: string
  email: string
  avatar?: ReactNode
  access: ReactNode
  status: 'active' | 'pending' | 'suspended'
  lastLogin?: string
}

function Identity({ account, heading = false }: { account: DirectoryAccount; heading?: boolean }) {
  const label = account.name || account.email
  const Group = heading ? 'div' : 'span'
  const Name = heading ? 'h3' : 'strong'
  return (
    <Group className={styles.identity}>
      {account.avatar ?? <span className={styles.initials} aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>}
      <Group className={styles.identityText}>
        <Name>{label}</Name>
        {label !== account.email && <small>{account.email}</small>}
      </Group>
    </Group>
  )
}

function Status({ value }: { value: DirectoryAccount['status'] }) {
  return <span className={styles.status} data-status={value}>{value[0].toUpperCase() + value.slice(1)}</span>
}

const NARROW_DIRECTORY_QUERY = '(max-width: 900px)'

interface DirectoryProps {
  kind: 'User' | 'Member'
  accounts: DirectoryAccount[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  toolbar: ReactNode
  empty: ReactNode
  loading?: boolean
  footer?: ReactNode
  children: ReactNode
}

export function AccountDirectory({ kind, accounts, selectedId, onSelect, toolbar, empty, loading, footer, children }: DirectoryProps) {
  const selected = accounts.find((account) => account.id === selectedId)
  const panelId = useId()
  const selectedRow = useRef<HTMLButtonElement | null>(null)
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_DIRECTORY_QUERY).matches ?? false)
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_DIRECTORY_QUERY)
    const update = () => setNarrow(media.matches)
    media?.addEventListener('change', update)
    return () => media?.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (selectedId && !narrow) closeButton.current?.focus({ preventScroll: true })
  }, [selectedId, narrow])

  function close() {
    onSelect(null)
    selectedRow.current?.focus({ preventScroll: true })
  }

  const staff = kind === 'User'
  const panelLabel = `${kind} details`
  const inspector = selected && (
    <article id={panelId} key={selected.id} aria-label={panelLabel} className={styles.inspector}
      onKeyDown={(event) => {
        if (!narrow && event.key === 'Escape' && event.target instanceof Node && event.currentTarget.contains(event.target)) {
          event.stopPropagation()
          close()
        }
      }}
    >
      <header className={styles.panelHeader}>
        <Identity account={selected} heading />
        {!narrow && <Button ref={closeButton} variant="ghost" iconOnly aria-label="Close details" onClick={close}>
          <CloseIcon size={16} aria-hidden="true" />
        </Button>}
        <Status value={selected.status} />
      </header>
      {children}
    </article>
  )

  return (
    <div className={styles.directory} data-split={Boolean(selected) && !narrow}>
      <div className={styles.list}>
        <div className={styles.toolbar}>{toolbar}</div>
        {loading ? <SkeletonRows ariaLabel="Loading accounts" count={3} rowHeight={48} /> : accounts.length === 0 ? empty : (
          <DataTable aria-label={staff ? 'Users' : 'Site members'} className={styles.table} density="compact">
            <DataTableHead><DataTableRow>
              <DataTableHeader>{kind}</DataTableHeader>
              <DataTableHeader className={styles.accessColumn}>{staff ? 'Role' : 'Access tags'}</DataTableHeader>
              <DataTableHeader className={styles.statusColumn}>Status</DataTableHeader>
              {staff && <DataTableHeader className={styles.loginColumn}>Last login</DataTableHeader>}
            </DataTableRow></DataTableHead>
            <DataTableBody>
              {accounts.map((account) => (
                <DataTableRow key={account.id} aria-label={`${kind} ${account.email}`} aria-current={account.id === selectedId || undefined}>
                  <DataTableCell>
                    <Button variant="ghost" align="start" className={styles.select} aria-expanded={account.id === selectedId}
                      aria-controls={account.id === selectedId ? panelId : undefined}
                      ref={account.id === selectedId ? selectedRow : undefined}
                      onClick={() => onSelect(account.id)}
                    >
                      <Identity account={account} />
                    </Button>
                  </DataTableCell>
                  <DataTableCell className={styles.accessColumn}><div className={styles.access}>{account.access}</div></DataTableCell>
                  <DataTableCell className={styles.statusColumn}><Status value={account.status} /></DataTableCell>
                  {staff && <DataTableCell className={styles.loginColumn}>{account.lastLogin}</DataTableCell>}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
        {footer}
      </div>
      {inspector && (narrow
        ? <Dialog open title={panelLabel} onClose={close} className={styles.drawer} bodyClassName={styles.drawerBody}>{inspector}</Dialog>
        : inspector)}
    </div>
  )
}
