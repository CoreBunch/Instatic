/**
 * Run-progress model for the Super Import wizard's Import step.
 *
 * Lives in its own module (not the component file) so it can be imported by the
 * modal, the step, and tests without tripping the `react-refresh` "only export
 * components" rule.
 *
 * Everything here is driven by real pipeline state — media (asset uploads) is
 * the only genuinely incremental phase; every other category lands in one
 * atomic commit, so those counts flip from 0 → committed-total together.
 */

type RunPhase = 'idle' | 'uploading' | 'applying' | 'done' | 'failed'

export type ImportCategoryId =
  | 'pages'
  | 'styles'
  | 'media'
  | 'colors'
  | 'fonts'
  | 'scripts'

export interface CategoryCount {
  done: number
  total: number
}

export interface RunProgress {
  phase: RunPhase
  categories: Record<ImportCategoryId, CategoryCount>
  /** The item currently being processed, shown in the mono ticker. */
  currentItem: string
  /** Populated when `phase === 'failed'`. */
  errorMessage?: string
}

export function makeInitialRunProgress(): RunProgress {
  const zero: CategoryCount = { done: 0, total: 0 }
  return {
    phase: 'idle',
    currentItem: '',
    categories: {
      pages: { ...zero },
      styles: { ...zero },
      media: { ...zero },
      colors: { ...zero },
      fonts: { ...zero },
      scripts: { ...zero },
    },
  }
}
