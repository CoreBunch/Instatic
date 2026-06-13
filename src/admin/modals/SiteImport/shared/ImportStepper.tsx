/**
 * ImportStepper — the four-stage progress rail shared by the Super Import
 * wizard's Review and Import screens.
 *
 * One source of truth for the stage list and their visual states so the
 * Review (`AnalyzeStep`) and Import (`ImportStep`) screens stay in lockstep.
 * Stages before `current` render as done (checked); `current` is highlighted;
 * later stages are upcoming. Pass `allDone` on the final completion frame so
 * every stage — including Import — shows as done.
 */
import { CheckIcon } from 'pixel-art-icons/icons/check'
import styles from './ImportStepper.module.css'

type ImportStage = 'drop' | 'review' | 'conflicts' | 'import'

const STAGES: { id: ImportStage; label: string }[] = [
  { id: 'drop', label: 'Drop' },
  { id: 'review', label: 'Review' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'import', label: 'Import' },
]

interface ImportStepperProps {
  /** The stage currently in progress. */
  current: ImportStage
  /** When true, every stage (including `current`) renders as done. */
  allDone?: boolean
}

export function ImportStepper({ current, allDone = false }: ImportStepperProps) {
  const currentIdx = STAGES.findIndex((s) => s.id === current)
  return (
    <ol className={styles.stepper} aria-label="Import progress">
      {STAGES.map((stage, i) => {
        const state =
          allDone || i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'upcoming'
        return (
          <li key={stage.id} className={styles.stepperItem} data-state={state}>
            <span className={styles.stepperDot}>
              {state === 'done' ? <CheckIcon size={9} /> : i + 1}
            </span>
            <span className={styles.stepperLabel}>{stage.label}</span>
          </li>
        )
      })}
    </ol>
  )
}
