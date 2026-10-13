/**
 * FragmentReport — what an insert adds, what it takes from the site as is,
 * and what the user should know. Rendered twice: as the review before
 * "Insert" (from the plan) and as the result after it (from the commit,
 * with media counts filled in).
 */

import type { FragmentInsertReport } from '@core/fragments'
import { Alert } from '@ui/components/Alert'
import styles from './InsertFragmentModal.module.css'

interface ReportRow {
  label: string
  values: string[]
}

const MAX_LISTED = 8

function list(values: string[]): string {
  if (values.length <= MAX_LISTED) return values.join(', ')
  return `${values.slice(0, MAX_LISTED).join(', ')} and ${values.length - MAX_LISTED} more`
}

function addedRows(report: FragmentInsertReport, done: boolean): ReportRow[] {
  const mediaLine = done
    ? [`${report.media.uploaded} uploaded`, `${report.media.reused} already in the library`]
    : report.media.total > 0 ? [`${report.media.total} file${report.media.total === 1 ? '' : 's'}`] : []
  return [
    { label: 'Page', values: report.page ? [`${report.page.title} (/${report.page.slug === 'index' ? '' : report.page.slug})`] : [] },
    { label: 'Classes', values: report.rules.added },
    { label: 'Selectors', values: report.rules.ambientAdded },
    { label: 'Colours', values: report.colors.added },
    { label: 'Type and space steps', values: report.steps.added.map((s) => `${s.convention}-${s.step}`) },
    { label: 'Font tokens', values: report.fonts.tokensAdded },
    { label: 'Font families', values: report.fonts.familiesAdded },
    { label: 'Custom properties', values: report.customProperties.added },
    { label: 'Conditions', values: report.conditions.added },
    { label: 'Components', values: report.components.added },
    { label: 'Tables', values: report.tables.created },
    { label: 'Table fields', values: report.tables.fieldsAdded },
    { label: 'Rows', values: report.tables.rows > 0 ? [String(report.tables.rows)] : [] },
    { label: 'Media', values: mediaLine },
  ].filter((row) => row.values.length > 0)
}

function keptRows(report: FragmentInsertReport): ReportRow[] {
  return [
    { label: 'Classes', values: report.rules.reused },
    { label: 'Selectors', values: report.rules.ambientKept },
    { label: 'Colours', values: report.colors.kept },
    { label: 'Font tokens', values: report.fonts.tokensKept },
    { label: 'Font families', values: report.fonts.familiesKept },
    { label: 'Custom properties', values: report.customProperties.kept },
    { label: 'Components', values: report.components.reused },
    { label: 'Tables', values: report.tables.reused },
  ].filter((row) => row.values.length > 0)
}

function ReportList({ rows }: { rows: ReportRow[] }) {
  return (
    <dl className={styles.reportList}>
      {rows.map((row) => (
        <div key={row.label} className={styles.reportRow}>
          <dt>{row.label}</dt>
          <dd>{list(row.values)}</dd>
        </div>
      ))}
    </dl>
  )
}

export function FragmentReport({ report, done }: { report: FragmentInsertReport; done: boolean }) {
  const added = addedRows(report, done)
  const kept = keptRows(report)
  const links = [
    ...report.links.remapped.map((slug) => `/${slug === 'index' ? '' : slug} kept`),
    ...report.links.unresolved.map((slug) => `/${slug} has no page here, linked to #`),
  ]

  return (
    <div className={styles.report}>
      <section aria-label={done ? 'Added' : 'Will add'}>
        <h3 className={styles.reportHeading}>{done ? 'Added' : 'Will add'}</h3>
        {added.length > 0 ? <ReportList rows={added} /> : <p className={styles.reportEmpty}>Only the layers. Everything they use is already here.</p>}
      </section>

      {kept.length > 0 && (
        <section aria-label="Kept from this site">
          <h3 className={styles.reportHeading}>Kept from this site</h3>
          <ReportList rows={kept} />
        </section>
      )}

      {links.length > 0 && (
        <section aria-label="Links">
          <h3 className={styles.reportHeading}>Links</h3>
          <ReportList rows={[{ label: 'Pages', values: links }]} />
        </section>
      )}

      {report.outsideDependencies.length > 0 && (
        <Alert tone="info" title="Styled by its old surroundings">
          These rules styled it through a parent class it does not bring:{' '}
          {list(report.outsideDependencies.map((d) => d.selector))}
        </Alert>
      )}

      {report.warnings.length > 0 && (
        <Alert tone="warning" title="Worth knowing">
          <ul className={styles.warningList}>
            {report.warnings.slice(0, MAX_LISTED).map((warning, index) => (
              <li key={`${warning.code}-${warning.subject ?? index}`}>{warning.message}</li>
            ))}
            {report.warnings.length > MAX_LISTED && <li>{report.warnings.length - MAX_LISTED} more</li>}
          </ul>
        </Alert>
      )}
    </div>
  )
}
