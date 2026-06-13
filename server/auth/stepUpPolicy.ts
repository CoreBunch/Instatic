export type StepUpAuthMode = 'required' | 'disabled'

const STEP_UP_WINDOW_MINUTES = [5, 15, 30, 60] as const
export type StepUpWindowMinutes = (typeof STEP_UP_WINDOW_MINUTES)[number]

const STEP_UP_DEFAULT_AUTH_MODE: StepUpAuthMode = 'required'
const STEP_UP_DEFAULT_WINDOW_MINUTES: StepUpWindowMinutes = 15
export const STEP_UP_DEFAULT_WINDOW_MS = STEP_UP_DEFAULT_WINDOW_MINUTES * 60 * 1000

export function normalizeStepUpAuthMode(value: unknown): StepUpAuthMode {
  return value === 'disabled' ? 'disabled' : STEP_UP_DEFAULT_AUTH_MODE
}

export function normalizeStepUpWindowMinutes(value: unknown): StepUpWindowMinutes {
  const minutes = Number(value)
  return STEP_UP_WINDOW_MINUTES.includes(minutes as StepUpWindowMinutes)
    ? minutes as StepUpWindowMinutes
    : STEP_UP_DEFAULT_WINDOW_MINUTES
}

export function stepUpWindowMs(minutes: StepUpWindowMinutes): number {
  return minutes * 60 * 1000
}
