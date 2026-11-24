import { useEffect, useId, useRef, type ReactNode } from 'react'
import { DIRECTORY_PAGE_SIZE } from '@core/users/directoryPagination'
import { DirectoryInspector } from '@admin/shared/Directory/DirectoryInspector'
import { Button } from '@ui/components/Button'
import { DataTable, DataTableBody, DataTableCell, DataTableHead, DataTableHeader, DataTableRow } from '@ui/components/DataTable'
import { SkeletonRows } from '@ui/components/Skeleton'
import styles from '@admin/shared/Directory/Directory.module.css'

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

interface DirectoryProps {
  kind: 'User' | 'Member'
  accounts: DirectoryAccount[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  toolbar: ReactNode
  empty: ReactNode
  loading?: boolean
  pagination: { offset: number; matching: number; busy: boolean; goTo: (offset: number) => void } | null
  children: ReactNode
}

export function AccountDirectory({ kind, accounts, selectedId, onSelect, toolbar, empty, loading, pagination, children }: DirectoryProps) {
  const selected = accounts.find((account) => account.id === selectedId)
  const panelId = useId()
  const listStart = useRef<HTMLDivElement>(null)
  const pagingFrom = useRef<number | null>(null)
  const offset = pagination?.offset
  useEffect(() => {
    if (pagingFrom.current !== null && offset !== pagingFrom.current) {
      pagingFrom.current = null
      listStart.current?.querySelector<HTMLButtonElement>('tbody button')?.focus({ preventScroll: true })
      listStart.current?.scrollIntoView({ block: 'start' })
    }
  }, [offset])

  function turnPage(nextOffset: number) {
    if (!pagination) return
    pagingFrom.current = pagination.offset
    onSelect(null)
    pagination.goTo(nextOffset)
  }

  const selectedRow = useRef<HTMLButtonElement | null>(null)
  function close() {
    onSelect(null)
    selectedRow.current?.focus({ preventScroll: true })
  }

  const staff = kind === 'User'
  return (
    <div className={styles.directory} data-split={Boolean(selected)}>
      <div className={styles.list} ref={listStart}>
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
        {pagination && pagination.matching > 0 && (
          <nav className={styles.pagination} aria-label={staff ? 'Admin users pagination' : 'Site members pagination'}>
            <Button variant="secondary" size="sm" disabled={pagination.busy || pagination.offset === 0}
              onClick={() => turnPage(pagination.offset - DIRECTORY_PAGE_SIZE)}>
              Previous
            </Button>
            <output>
              {(pagination.offset + 1).toLocaleString()}–{(pagination.offset + accounts.length).toLocaleString()} of {pagination.matching.toLocaleString()}
            </output>
            <Button variant="secondary" size="sm" disabled={pagination.busy || pagination.offset + accounts.length >= pagination.matching}
              onClick={() => turnPage(pagination.offset + DIRECTORY_PAGE_SIZE)}>
              Next
            </Button>
          </nav>
        )}
      </div>
      {selected && (
        <DirectoryInspector key={selected.id} id={panelId} label={`${kind} details`} onClose={close}
          heading={<Identity account={selected} heading />}
          status={<Status value={selected.status} />}
        >
          {children}
        </DirectoryInspector>
      )}
    </div>
  )
}
