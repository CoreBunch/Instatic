/**
 * Users → Audit tab.
 *
 * Read-only feed of `audit_events` rows: every security-sensitive
 * change in the admin area (logins, user/role mutations, plugin lifecycle,
 * publishes). Each row is rendered into a sentence-case title + optional
 * detail badges + actor attribution + timestamp.
 *
 * The actor / target labels are looked up against the *current* users and
 * roles maps, falling back to the snapshot label captured at write time
 * when the related row no longer exists. That's why this tab consumes
 * `users` and `roles` even though it doesn't mutate them.
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
import type { UsersPageData } from '../hooks/useUsersPageData'
import styles from '../UsersPage.module.css'

export function AuditTab({ data }: { data: UsersPageData }) {
  const { users, roles, events } = data
  const usersById = new Map(users.map((user) => [user.id, user]))
  const rolesById = new Map(roles.map((role) => [role.id, role]))

  return (
    <section className={styles.section} aria-labelledby="audit-events-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="audit-events-title">Audit Events</h2>
          <p>Security and access changes across the admin area.</p>
        </div>
      </div>
      {data.loading ? (
        <DataTable aria-label="Loading audit events" density="compact" aria-busy="true">
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
        <DataTable aria-label="Audit events" density="compact">
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
                  <strong className={styles.auditTitle}>{auditTitle(event, usersById, rolesById)}</strong>
                </DataTableCell>
                <DataTableCell>
                  <span className={styles.secondaryText}>{auditActor(event, usersById)}</span>
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
        <p className={styles.emptyState}>No audit events yet.</p>
      )}
    </section>
  )
}
