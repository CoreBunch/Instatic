/**
 * Names what a destructive media action is about to break.
 *
 * Rendered inside the confirmation, not instead of it: the operator is still
 * allowed to go ahead — replacing an avatar begins by deleting the old one —
 * so this informs and gets out of the way. `buildUsageWarning` owns the
 * wording; this owns how it looks.
 *
 * `role="status"` rather than `alert`: the dialog announces itself on open and
 * the assertive interruption belongs to that, not to a detail inside it.
 */
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import type { UsageWarning } from '../../utils/usageWarning'
import s from './UsageWarningNotice.module.css'

export function UsageWarningNotice({ warning }: { warning: UsageWarning | null }) {
  if (!warning) return null
  return (
    <div className={s.notice} role="status">
      <WarningDiamondSolidIcon size={16} aria-hidden="true" className={s.icon} />
      <div className={s.body}>
        <p className={s.heading}>{warning.heading}</p>
        <ul className={s.list}>
          {warning.lines.map((line) => (
            <li key={line} className={s.item}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
