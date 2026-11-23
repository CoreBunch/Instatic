/**
 * Users → Audit tab.
 *
 * Read-only feed of `audit_events` rows: every security-sensitive
 * change in the admin area (logins, user/role mutations, plugin lifecycle,
 * publishes). Each row is rendered into a sentence-case title + optional
 * detail badges + actor attribution + timestamp.
 *
 * The API resolves actor and target labels across the whole directory.
 */
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@ui/components/DataTable'
import { Skeleton } from '@ui/components/Skeleton'
import { Badge } from '../components/Badge'
import { auditActor, auditDetails, auditTitle } from '../utils/audit'
import { formatDateTime } from '../utils/format'
import { listCmsAuditEvents, type CmsRole } from '@core/persistence'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import auditTable from '@admin/shared/AuditTable/AuditTable.module.css'
import styles from '../UsersPage.module.css'
import { EmptyState } from '@ui/components/EmptyState'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'

export function AuditTab({ roles }: { roles: CmsRole[] }) {
  const audit = useAsyncResource(() => listCmsAuditEvents(), [], { fallbackError: 'Could not load audit events' })
  const events = audit.data ?? []
  const rolesById = new Map(roles.map((role) => [role.id, role]))

  return (
    <section className={styles.section} aria-labelledby="audit-events-title">
      <div className={styles.sectionHeader}>
        <h1 id="audit-events-title">Audit Events</h1>
      </div>
      {audit.error && <p className={styles.error} role="alert">{audit.error}</p>}
      {audit.loading ? (
        <DataTable className={auditTable.table} aria-label="Loading audit events" density="compact" aria-busy="true">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">Event</DataTableHeader>
              <DataTableHeader scope="col">Actor</DataTableHeader>
              <DataTableHeader scope="col">Details</DataTableHeader>
              <DataTableHeader scope="col">Time</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {Array.from({ length: 4 }, (_, i) => (
              <DataTableRow key={`skeleton-${i}`}>
                <DataTableCell><Skeleton width={180} height={13} /></DataTableCell>
                <DataTableCell><Skeleton width={120} height={12} /></DataTableCell>
                <DataTableCell><Skeleton width={80} height={18} radius={999} /></DataTableCell>
                <DataTableCell><Skeleton width={100} height={12} /></DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      ) : events.length > 0 ? (
        <DataTable className={auditTable.table} aria-label="Audit events" density="compact">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">Event</DataTableHeader>
              <DataTableHeader scope="col">Actor</DataTableHeader>
              <DataTableHeader scope="col">Details</DataTableHeader>
              <DataTableHeader scope="col">Time</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {events.map((event) => (
              <DataTableRow key={event.id}>
                <DataTableCell>
                  <strong className={styles.auditTitle}>{auditTitle(event, rolesById)}</strong>
                </DataTableCell>
                <DataTableCell>
                  <span className={styles.secondaryText}>{auditActor(event)}</span>
                </DataTableCell>
                <DataTableCell>
                  <div className={styles.auditDetails}>
                    {auditDetails(event, rolesById).map((detail) => (
                      <Badge key={detail} label={detail} />
                    ))}
                  </div>
                </DataTableCell>
                <DataTableCell>
                  <span className={styles.secondaryText}>{formatDateTime(event.createdAt)}</span>
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      ) : (
        <EmptyState
          variant="centered"
          icon={<ListBoxSolidIcon size={28} />}
          title="No audit events yet"
          description="Sign-ins and changes to users, roles and security settings appear here."
        />
      )}
    </section>
  )
}
