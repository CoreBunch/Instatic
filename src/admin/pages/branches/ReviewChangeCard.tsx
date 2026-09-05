/**
 * ReviewChangeCard — the right-hand side of one timeline node: what the
 * change looks like. Pages get before/after frames, entries a field table,
 * tables their schema, the shell its settings, files a line diff. A change
 * with a conflict carries the decision strip on top.
 */
import type { MergeChange, MergeFieldChange, MergeResolution } from '@core/branches'
import { countDiffLines, diffLines } from '@core/utils/lineDiff'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { TagPill } from '@ui/components/TagPill'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { PageCompare } from './PageCompare'
import { ACTION_TONE, ACTION_WORD, changeKindLabel, isPageChange } from './reviewFormat'
import styles from './BranchReviewPage.module.css'

interface ReviewChangeCardProps {
  branchId: string
  change: MergeChange
  resolution: MergeResolution | undefined
  canResolve: boolean
  onResolve: (resolution: MergeResolution) => void
}

function describeConflicts(conflicts: readonly string[]): string {
  if (conflicts.includes('(deleted)')) return 'Deleted on one side, changed on the other.'
  const fields = conflicts.slice(0, 3).map((path) => path.replace(/^cells\./, '')).join(', ')
  return conflicts.length > 3
    ? `Both sides changed ${fields} and ${conflicts.length - 3} more.`
    : `Both sides changed ${fields}.`
}

function ConflictStrip({ change, resolution, canResolve, onResolve }: Omit<ReviewChangeCardProps, 'branchId'>) {
  if (change.conflicts.length === 0) return null
  return (
    <div className={styles.conflictStrip} data-resolved={resolution ? 'true' : 'false'} data-testid={`review-conflict-${change.key}`}>
      <WarningDiamondSolidIcon size={14} aria-hidden="true" />
      <span className={styles.conflictText}>
        <strong>
          {resolution
            ? resolution === 'into' ? 'Resolved: keeping main.' : 'Resolved: taking the branch.'
            : 'Conflict.'}
        </strong>{' '}
        {describeConflicts(change.conflicts)}
        {!canResolve && ' A branch manager decides which side wins.'}
      </span>
      {canResolve && (
        <SegmentedControl
          value={resolution}
          size="xs"
          aria-label={`Resolve ${change.label}`}
          options={[
            { value: 'into', label: 'Keep main' },
            { value: 'from', label: 'Take branch' },
          ]}
          onChange={onResolve}
        />
      )}
    </div>
  )
}

function FieldTable({ fields, action }: { fields: MergeFieldChange[]; action: MergeChange['action'] }) {
  if (fields.length === 0) return <p className={styles.cardEmpty}>No field-level difference to show.</p>
  return (
    <table className={styles.fieldTable}>
      <thead>
        <tr>
          <th>Field</th>
          <th>Main</th>
          <th>Branch</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.id} className={styles.fieldRow} data-changed="true" data-conflict={field.conflict ? 'true' : 'false'}>
            <td className={styles.fieldName}>{field.label}</td>
            <td className={styles.cellBefore} data-structured={field.structured ? 'true' : 'false'}>
              {field.before ?? <span className={styles.cellEmpty}>{action === 'create' ? 'none' : 'empty'}</span>}
            </td>
            <td className={styles.cellAfter} data-structured={field.structured ? 'true' : 'false'}>
              {field.after ?? <span className={styles.cellEmpty}>{action === 'delete' ? 'removed' : 'empty'}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function fieldLines(fields: MergeFieldChange[]): string[] {
  return fields.map((field) => {
    if (field.before === null) return `${field.label}: set to “${field.after ?? ''}”`
    if (field.after === null) return `${field.label}: cleared (was “${field.before}”)`
    return `${field.label}: “${field.before}” → “${field.after}”`
  })
}

export function ReviewChangeCard({ branchId, change, resolution, canResolve, onResolve }: ReviewChangeCardProps) {
  const { detail } = change
  const header = (
    <div className={styles.cardHead}>
      <TagPill label={changeKindLabel(change)} size="xs" />
      <strong className={detail.kind === 'file' ? styles.mono : undefined}>{change.label}</strong>
      {detail.kind === 'file' && detail.pathBefore && (
        <span className={styles.cardPath}>was {detail.pathBefore}</span>
      )}
      <span className={styles.spacer} />
      {detail.kind === 'file' && !detail.binary && <FileCounts before={detail.before ?? ''} after={detail.after ?? ''} />}
      <TagPill label={ACTION_WORD[change.action]} size="xs" tone={ACTION_TONE[change.action]} />
    </div>
  )

  let body
  if (detail.kind === 'row' && isPageChange(change)) {
    body = (
      <PageCompare
        branchId={branchId}
        rowId={change.logicalId}
        label={change.label}
        action={change.action}
        tree={detail.tree}
        fieldLines={fieldLines(detail.fields)}
        mainLabel={change.conflicts.length > 0 ? 'Main, as it is now' : 'Main'}
      />
    )
  } else if (detail.kind === 'row') {
    body = (
      <>
        <FieldTable fields={detail.fields} action={change.action} />
        {detail.tree && (
          <ul className={styles.changeList}>
            {detail.tree.added.map((id) => <li key={`a-${id}`}>Added {detail.tree!.labels[id] ?? id}</li>)}
            {detail.tree.changed.map((id) => {
              const details = detail.tree!.details[id] ?? []
              return (
                <li key={`c-${id}`}>
                  Changed {detail.tree!.labels[id] ?? id}
                  {details.length > 0 && `: ${details.join('; ')}`}
                </li>
              )
            })}
            {detail.tree.removed.map((id) => <li key={`r-${id}`}>Removed {detail.tree!.labels[id] ?? id}</li>)}
          </ul>
        )}
      </>
    )
  } else if (detail.kind === 'table') {
    body = (
      <>
        {detail.fields.length > 0 && <FieldTable fields={detail.fields} action={change.action} />}
        <ul className={styles.schemaList}>
          {detail.schema.map((field) => (
            <li key={field.id} className={styles.schemaRow}>
              <span>{field.label}</span>
              <span className={styles.schemaType}>{field.type}</span>
              <TagPill
                className={styles.schemaStatus}
                label={field.status === 'same' ? 'unchanged' : field.status}
                size="xs"
                muted={field.status === 'same'}
                tone={field.status === 'new' ? 'success' : field.status === 'changed' ? 'warning' : field.status === 'removed' ? 'danger' : undefined}
              />
            </li>
          ))}
        </ul>
      </>
    )
  } else if (detail.kind === 'site') {
    body = <FieldTable fields={detail.fields} action={change.action} />
  } else if (detail.binary) {
    body = <p className={styles.cardEmpty}>Binary asset ({detail.fileType}); no text to compare.</p>
  } else {
    body = <LineDiff before={detail.before ?? ''} after={detail.after ?? ''} />
  }

  return (
    <section className={styles.card} data-testid={`review-change-${change.key}`}>
      {header}
      <ConflictStrip change={change} resolution={resolution} canResolve={canResolve} onResolve={onResolve} />
      <div className={styles.cardBody}>{body}</div>
    </section>
  )
}

function FileCounts({ before, after }: { before: string; after: string }) {
  const counts = countDiffLines(diffLines(before, after))
  return (
    <span className={styles.fileCounts}>
      <span className={styles.add}>+{counts.additions}</span>
      {counts.deletions > 0 && <span className={styles.del}>−{counts.deletions}</span>}
    </span>
  )
}

function LineDiff({ before, after }: { before: string; after: string }) {
  const rows = diffLines(before, after)
  return (
    <div className={styles.diff}>
      {rows.map((row, index) => (
        <div key={index} className={styles.diffRow} data-type={row.type}>
          <span className={styles.diffNo}>{row.before ?? ''}</span>
          <span className={styles.diffNo}>{row.after ?? ''}</span>
          <span className={styles.diffSign}>{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}</span>
          <span className={styles.diffCode}>{row.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
