/**
 * FrameworkChangeConfirmDialog — confirmation prompt shown before a
 * destructive framework change (disable token, disable shades/tints,
 * remove a typography/spacing group, etc.) actually deletes
 * framework-generated classes that are still assigned to elements.
 *
 * The dialog lists every soon-to-be-removed class along with the specific
 * elements (and the page or visual component each lives in) that are
 * currently using it. The user can choose to drop the assignments and
 * proceed, or cancel.
 *
 * Built on the shared `<Dialog>` primitive — chrome / focus / Esc / portal
 * mount come from there. This module owns the destructive-action body.
 */

import { useRef } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import type {
  FrameworkChangeImpact,
  FrameworkClassUsageRef,
} from '@core/framework'
import styles from './FrameworkChangeConfirmDialog.module.css'

interface FrameworkChangeConfirmDialogProps {
  /** What the change will remove and where each removed class is used. */
  impact: FrameworkChangeImpact
  /**
   * Action verb used in the title and the confirm button (e.g. "Disable
   * tints", "Delete token"). Keep it short — under 24 chars.
   */
  actionLabel: string
  onCancel: () => void
  onConfirm: () => void
}

export function FrameworkChangeConfirmDialog({
  impact,
  actionLabel,
  onCancel,
  onConfirm,
}: FrameworkChangeConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Group usages by classId so the body lists "<class> — N place(s)"
  // followed by per-place rows. Classes with no usages aren't rendered
  // (they'll be removed silently by the commit).
  const grouped = groupUsagesByClass(impact.usages)
  const totalUsages = impact.usages.length
  const removedInUseCount = grouped.length

  return (
    <Dialog
      open
      onClose={onCancel}
      tone="danger"
      title={`${actionLabel}?`}
      size="lg"
      initialFocusRef={confirmRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant="destructive"
            size="sm"
            type="button"
            onClick={onConfirm}
          >
            {actionLabel}
          </Button>
        </>
      }
    >
      <p className={styles.summary}>
        <span className={styles.summaryStrong}>{removedInUseCount}</span>
        {' '}
        generated {removedInUseCount === 1 ? 'class is' : 'classes are'} still
        assigned to{' '}
        <span className={styles.summaryStrong}>{totalUsages}</span>
        {' '}
        {totalUsages === 1 ? 'element' : 'elements'}.
      </p>
      <p className={styles.subline}>
        Proceeding will remove the {removedInUseCount === 1 ? 'class' : 'classes'} from
        every element below. The {removedInUseCount === 1 ? 'class itself' : 'classes themselves'} will
        be deleted from the site.
      </p>

      {grouped.map((group) => (
        <div key={group.classId} className={styles.classGroup}>
          <div className={styles.classHeader}>
            <span className={styles.classSelector}>.{group.className}</span>
            <span className={styles.classCount}>
              {group.usages.length === 1 ? '1 use' : `${group.usages.length} uses`}
            </span>
          </div>
          <ul className={styles.usageList} aria-label={`Uses of .${group.className}`}>
            {group.usages.map((usage) => (
              <li key={usageKey(usage)} className={styles.usageItem}>
                <span className={styles.usageScope}>
                  {usageScopeLabel(usage)}
                </span>
                <span className={styles.usageNode} title={usage.source.nodeLabel}>
                  {usage.source.nodeLabel}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Dialog>
  )
}

interface GroupedUsage {
  classId: string
  className: string
  usages: FrameworkClassUsageRef[]
}

function groupUsagesByClass(usages: FrameworkClassUsageRef[]): GroupedUsage[] {
  const byClassId = new Map<string, GroupedUsage>()
  for (const usage of usages) {
    const existing = byClassId.get(usage.classId)
    if (existing) {
      existing.usages.push(usage)
    } else {
      byClassId.set(usage.classId, {
        classId: usage.classId,
        className: usage.className,
        usages: [usage],
      })
    }
  }
  return Array.from(byClassId.values()).sort((a, b) =>
    a.className.localeCompare(b.className),
  )
}

function usageScopeLabel(usage: FrameworkClassUsageRef): string {
  return usage.source.kind === 'page'
    ? usage.source.pageTitle
    : `Component · ${usage.source.vcName}`
}

function usageKey(usage: FrameworkClassUsageRef): string {
  return `${usage.source.kind}:${usage.classId}:${usage.source.nodeId}`
}
