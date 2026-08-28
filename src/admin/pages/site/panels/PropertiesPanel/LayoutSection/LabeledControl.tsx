/**
 * LabeledControl — the inspector's property row: a fixed label column and a
 * control column, used by every flex / grid / position sub-field.
 *
 * Row anatomy is the prototype's `.row` (`grid-template-columns:
 * var(--label-column) minmax(0, 1fr)`), and the "is this property set?" cue
 * is a 5px accent dot in front of the label — never a colour change. The
 * label keeps one tone (`--text-muted`) whatever the state, exactly like
 * SizeSection's rows.
 *
 * (Currently LayoutSection + PositionSection. If a third visual section needs
 * the same row, promote this to a shared property-control primitive — nothing
 * here is LayoutSection-specific.)
 */

import type { ReactNode } from 'react'
import styles from '../LayoutSection.module.css'

interface LabeledControlProps {
  label: string
  /** Whether the underlying CSS property has a value set — renders the dot. */
  isSet?: boolean
  children: ReactNode
}

export function LabeledControl({ label, isSet, children }: LabeledControlProps) {
  return (
    <div className={styles.labeledRow} data-state={isSet ? 'set' : 'unset'}>
      <span className={styles.labeledLabel}>
        {isSet && <span className={styles.labeledDot} aria-hidden="true" />}
        {label}
      </span>
      <div className={styles.labeledControl}>{children}</div>
    </div>
  )
}
