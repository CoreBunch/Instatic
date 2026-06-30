/**
 * FrameworkManagerDialog — set the Core Framework to one declarative state.
 *
 * Presentation-only: an injected `FrameworkManagerApplier` performs the actual
 * mutation. The user picks ONE target state and applies it; the dialog never
 * exposes separate add/remove verbs — switching to a different state reconciles
 * everything (adds what's missing, strips what the new state drops).
 *
 * Three states (radio cards):
 *   • Full framework  — utility classes + :root variables.
 *   • Variables only  — :root variables, no generated utility classes.
 *   • None            — remove the framework entirely (destructive; hidden when
 *                       the applier can't remove, e.g. onboarding's importer).
 *
 * The card matching the current state is pre-selected; applying is only enabled
 * once a different state is chosen.
 */
import { useRef, useState, type CSSProperties } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { cn } from '@ui/cn'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { FrameworkPreset } from '@core/framework'
import type { PixelArtIconComponent } from '@core/dashboard'
import type { FrameworkManagerApplier } from './applier'
import styles from './FrameworkManagerDialog.module.css'

interface StateOption {
  id: FrameworkPreset
  title: string
  desc: string
  icon: PixelArtIconComponent
  bullets: readonly string[]
  /** Removal is destructive — gated behind `capabilities.canRemove`. */
  destructive?: boolean
}

const STATES: readonly StateOption[] = [
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
  {
    id: 'none',
    title: 'None',
    desc: 'Remove the Core Framework entirely — every variable and generated class.',
    icon: TrashSolidIcon,
    destructive: true,
    bullets: [
      'No :root framework variables',
      'No generated utility classes',
      'Your own styles stay untouched',
    ],
  },
]

interface FrameworkManagerDialogProps {
  open: boolean
  onClose: () => void
  applier: FrameworkManagerApplier
  /** The framework's current state — pre-selects a card and gates the button. */
  currentState: FrameworkPreset
  /** How many elements reference framework classes (drives the remove warning). */
  usedFrameworkClassCount: number
  /** Called after any successful apply. */
  onApplied?: () => void
}

/** Default selection when opening: the current state, or 'full' when there's nothing yet. */
function defaultTarget(currentState: FrameworkPreset): FrameworkPreset {
  return currentState === 'none' ? 'full' : currentState
}

export function FrameworkManagerDialog({
  open,
  onClose,
  applier,
  currentState,
  usedFrameworkClassCount,
  onApplied,
}: FrameworkManagerDialogProps) {
  const [target, setTarget] = useState<FrameworkPreset>(() => defaultTarget(currentState))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  const applyButtonRef = useRef<HTMLButtonElement | null>(null)

  // Re-sync the picker to the live state each time the dialog opens, so it
  // always reflects reality rather than the last session's choice. Adjusting
  // state during render (not in an effect) is the React-sanctioned pattern for
  // resetting state when a prop changes.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setTarget(defaultTarget(currentState))
      setConfirmingRemove(false)
      setError(null)
    }
  }

  function requestClose() {
    if (busy) return
    setError(null)
    setConfirmingRemove(false)
    onClose()
  }

  function selectTarget(next: FrameworkPreset) {
    setTarget(next)
    setConfirmingRemove(false)
  }

  function handleApply() {
    if (target === 'none' && !confirmingRemove) {
      setConfirmingRemove(true)
      return
    }
    void (async () => {
      setBusy(true)
      setError(null)
      try {
        await applier.apply(target)
        onApplied?.()
        onClose()
      } catch (err) {
        console.error('[FrameworkManagerDialog] apply failed:', err)
        setError(getErrorMessage(err, 'Could not update the framework.'))
      } finally {
        setBusy(false)
        setConfirmingRemove(false)
      }
    })()
  }

  const removing = target === 'none'
  const noChange = target === currentState
  const hasFramework = currentState !== 'none'

  const visibleStates = STATES.filter(
    (option) => option.id !== 'none' || applier.capabilities.canRemove,
  )

  function applyLabel(): string {
    if (busy) return removing ? 'Removing…' : 'Applying…'
    if (noChange) return 'Up to date'
    if (removing) return confirmingRemove ? 'Confirm remove' : 'Remove framework'
    if (currentState === 'none') return 'Import framework'
    return 'Update framework'
  }

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      eyebrow="Core Framework"
      title={hasFramework ? 'Manage the framework' : 'Import the framework'}
      size="2xl"
      initialFocusRef={applyButtonRef}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      footer={
        <Button variant="ghost" onClick={requestClose} disabled={busy}>
          Close
        </Button>
      }
    >
      <p className={styles.lede}>
        Seed your design tokens from the Core Framework defaults — colors, a
        fluid type scale, a spacing scale, and their utility classes. Pick the
        state you want; switching adds what's missing and strips what the new
        state drops.
      </p>

      <div
        className={styles.options}
        role="radiogroup"
        aria-label="Framework state"
        style={{ '--option-count': visibleStates.length } as CSSProperties}
      >
        {visibleStates.map((option) => {
          const OptionIcon = option.icon
          const selected = target === option.id
          return (
            <button
              type="button"
              key={option.id}
              role="radio"
              aria-checked={selected}
              className={cn(
                styles.option,
                selected && styles.optionSelected,
                option.destructive && selected && styles.optionDestructive,
              )}
              onClick={() => selectTarget(option.id)}
              disabled={busy}
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
          ref={applyButtonRef}
          variant={removing ? 'destructive' : 'primary'}
          className={styles.applyButton}
          onClick={handleApply}
          disabled={busy || noChange}
        >
          {applyLabel()}
        </Button>
      </div>

      {removing && confirmingRemove && usedFrameworkClassCount > 0 && (
        <p className={styles.removeWarning} role="alert">
          {usedFrameworkClassCount} element{usedFrameworkClassCount === 1 ? '' : 's'} use
          framework classes — those references will be removed.
        </p>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
