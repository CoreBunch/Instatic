/**
 * FrameworkManagerDialog — import / remove the Core Framework preset.
 *
 * Presentation-only: an injected `FrameworkManagerApplier` performs the actual
 * mutation. The site editor passes an applier backed by store actions (import +
 * remove + prune, with reconcile + undo); onboarding passes an import-only
 * applier (cmsAdapter) with `capabilities.canRemove === false`, which hides the
 * Remove region so the dialog behaves exactly like a plain importer.
 *
 * Two import modes (radio cards):
 *   • Full framework  — utility classes + :root variables.
 *   • Variables only  — :root variables, no generated utility classes.
 * When a framework already exists, importing MERGES (adds only missing tokens).
 */
import { useRef, useState } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { cn } from '@ui/cn'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { PixelArtIconComponent } from '@core/dashboard'
import type { FrameworkImportMode, FrameworkManagerApplier } from './applier'
import styles from './FrameworkManagerDialog.module.css'

interface ModeOption {
  id: FrameworkImportMode
  title: string
  desc: string
  icon: PixelArtIconComponent
  bullets: readonly string[]
}

const MODES: readonly ModeOption[] = [
  {
    id: 'full',
    title: 'Full framework',
    desc: 'Utility classes + variables. The complete Core Framework, ready to use on the canvas.',
    icon: CodeIcon,
    bullets: [
      'Color, text & spacing utility classes',
      ':root variables for every token',
      'Whole utility set shipped in framework.css',
    ],
  },
  {
    id: 'variables',
    title: 'Variables only',
    desc: 'Just the :root custom properties — bring your own classes and CSS.',
    icon: SlidersHorizontalIcon,
    bullets: [
      ':root variables for every token',
      'Shades, tints & transparent steps',
      'No generated utility classes',
    ],
  },
]

interface FrameworkManagerDialogProps {
  open: boolean
  onClose: () => void
  applier: FrameworkManagerApplier
  /** True when the site already carries framework settings. */
  hasFramework: boolean
  /** How many elements reference framework classes (drives the remove warning). */
  usedFrameworkClassCount: number
  /** Called after any successful apply (import / remove / prune). */
  onApplied?: () => void
}

type Busy = 'import' | 'removeAll' | 'pruneUnused' | null

export function FrameworkManagerDialog({
  open,
  onClose,
  applier,
  hasFramework,
  usedFrameworkClassCount,
  onApplied,
}: FrameworkManagerDialogProps) {
  const [mode, setMode] = useState<FrameworkImportMode>('full')
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const importButtonRef = useRef<HTMLButtonElement | null>(null)
  const saving = busy !== null

  function requestClose() {
    if (saving) return
    setError(null)
    setConfirmingRemove(false)
    onClose()
  }

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    setBusy(kind)
    setError(null)
    try {
      await fn()
      onApplied?.()
      onClose()
    } catch (err) {
      console.error('[FrameworkManagerDialog] apply failed:', err)
      setError(getErrorMessage(err, 'Could not update the framework.'))
    } finally {
      setBusy(null)
      setConfirmingRemove(false)
    }
  }

  const showRemove = applier.capabilities.canRemove && hasFramework

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      eyebrow="Core Framework"
      title={hasFramework ? 'Manage the framework' : 'Import the framework'}
      size="lg"
      initialFocusRef={importButtonRef}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      footer={
        <Button variant="ghost" onClick={requestClose} disabled={saving}>
          Close
        </Button>
      }
    >
      <p className={styles.lede}>
        Seed your design tokens from the Core Framework defaults — colors, a
        fluid type scale, a spacing scale, and their utility classes.
        {hasFramework
          ? ' Re-importing adds only the tokens you are missing.'
          : ' Pick how much you want.'}
      </p>

      <div className={styles.options} role="radiogroup" aria-label="Import mode">
        {MODES.map((option) => {
          const OptionIcon = option.icon
          const selected = mode === option.id
          return (
            <button
              type="button"
              key={option.id}
              role="radio"
              aria-checked={selected}
              className={cn(styles.option, selected && styles.optionSelected)}
              onClick={() => setMode(option.id)}
              disabled={saving}
            >
              <span className={styles.optionHead}>
                <span className={styles.optionIcon} aria-hidden="true">
                  <OptionIcon size={16} />
                </span>
                <span className={styles.optionTitle}>{option.title}</span>
                {selected && (
                  <span className={styles.optionTick} aria-hidden="true">
                    <CheckIcon size={11} />
                  </span>
                )}
              </span>
              <span className={styles.optionDesc}>{option.desc}</span>
              <ul className={styles.optionBullets}>
                {option.bullets.map((bullet) => (
                  <li key={bullet}>
                    <span className={styles.bulletIcon} aria-hidden="true">
                      <CheckIcon size={11} />
                    </span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </button>
          )
        })}
      </div>

      <div className={styles.actionRow}>
        <Button
          ref={importButtonRef}
          variant="primary"
          onClick={() => run('import', () => applier.import(mode))}
          disabled={saving}
        >
          {busy === 'import'
            ? 'Importing…'
            : hasFramework
              ? 'Add missing tokens'
              : 'Import framework'}
        </Button>
      </div>

      {showRemove && (
        <div className={styles.removeRegion}>
          <h3 className={styles.removeTitle}>Remove</h3>
          <div className={styles.removeActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => applier.pruneUnused && run('pruneUnused', applier.pruneUnused)}
              disabled={saving}
            >
              {busy === 'pruneUnused' ? 'Removing…' : 'Remove unused classes'}
            </Button>

            {!confirmingRemove ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmingRemove(true)}
                disabled={saving}
              >
                Remove framework completely
              </Button>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => applier.removeAll && run('removeAll', applier.removeAll)}
                disabled={saving}
              >
                {busy === 'removeAll' ? 'Removing…' : 'Confirm remove'}
              </Button>
            )}
          </div>
          {confirmingRemove && usedFrameworkClassCount > 0 && (
            <p className={styles.removeWarning} role="alert">
              {usedFrameworkClassCount} element{usedFrameworkClassCount === 1 ? '' : 's'} use
              framework classes — those references will be removed.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
