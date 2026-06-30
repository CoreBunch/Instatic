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
 * once a different state is chosen. Applying routes through the shared
 * `useFrameworkChangeConfirm` flow, so a destructive switch (dropping utility
 * classes still in use) raises the same FrameworkChangeConfirmDialog the rest
 * of the editor uses; non-destructive switches commit immediately.
 */
import { useRef, useState, type CSSProperties } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import { getErrorMessage } from '@core/utils/errorMessage'
import { applyFrameworkPreset, type FrameworkPreset } from '@core/framework'
import type { PixelArtIconComponent } from '@core/dashboard'
import { useFrameworkChangeConfirm } from '@admin/shared/dialogs/FrameworkChangeConfirmDialog'
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
  /** The framework's current state — gates the button (sameState / nothingToDo). */
  currentState: FrameworkPreset
  /**
   * Target to pre-select when the dialog opens. Defaults to `currentState`
   * (the in-editor "Manage framework" host wants the picker to reflect reality).
   * The onboarding "Import framework" step passes `'full'` instead so the step
   * opens ready to import — otherwise a no-framework site (`currentState:
   * 'none'`) would land on "None" selected with an "Up to date" no-op button.
   */
  initialTarget?: FrameworkPreset
  /** Called after any successful apply. */
  onApplied?: () => void
}

export function FrameworkManagerDialog({
  open,
  onClose,
  applier,
  currentState,
  initialTarget = currentState,
  onApplied,
}: FrameworkManagerDialogProps) {
  // Preselect `initialTarget` (defaults to the current state, not a fixed value).
  const [target, setTarget] = useState<FrameworkPreset>(initialTarget)
  const [busy, setBusy] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  const applyButtonRef = useRef<HTMLButtonElement | null>(null)
  const confirmFrameworkChange = useFrameworkChangeConfirm()

  // Re-sync the picker each time the dialog opens, so it reflects the intended
  // starting target rather than the last session's choice. Adjusting state
  // during render (not in an effect) is the React-sanctioned pattern for
  // resetting state when a prop changes.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setTarget(initialTarget)
  }

  function requestClose() {
    if (busy) return
    onClose()
  }

  function runApply() {
    setBusy(true)
    void (async () => {
      try {
        await applier.apply(target)
        onApplied?.()
        onClose()
      } catch (err) {
        console.error('[FrameworkManagerDialog] apply failed:', err)
        pushToast({
          kind: 'error',
          title: 'Could not update the framework',
          body: getErrorMessage(err, 'Unknown framework error'),
        })
      } finally {
        setBusy(false)
      }
    })()
  }

  function handleApply() {
    // Route through the shared confirm flow: it previews the settings change,
    // and only raises the FrameworkChangeConfirmDialog when the switch would
    // drop utility classes that are still in use — otherwise commits silently.
    confirmFrameworkChange({
      actionLabel: confirmActionLabel(),
      applyChange: (draft) => {
        draft.settings.framework = applyFrameworkPreset(draft.settings.framework, target)
      },
      commit: runApply,
    })
  }

  const removing = target === 'none'
  const sameState = target === currentState
  const hasFramework = currentState !== 'none'
  // Only "None when there's no framework" is a true no-op. Re-picking the
  // current full / variables state still merges any missing preset tokens
  // (e.g. colors you never added), so it stays actionable.
  const nothingToDo = removing && currentState === 'none'

  const visibleStates = STATES.filter(
    (option) => option.id !== 'none' || applier.capabilities.canRemove,
  )

  function confirmActionLabel(): string {
    if (target === 'none') return 'Remove framework'
    if (target === 'variables') return 'Switch to variables'
    return 'Update framework'
  }

  function applyLabel(): string {
    if (busy) return removing ? 'Removing…' : 'Applying…'
    if (nothingToDo) return 'Up to date'
    if (removing) return 'Remove framework'
    if (currentState === 'none') return 'Import framework'
    if (sameState) return 'Add missing tokens'
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
              onClick={() => setTarget(option.id)}
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
          disabled={busy || nothingToDo}
        >
          {applyLabel()}
        </Button>
      </div>
    </Dialog>
  )
}
