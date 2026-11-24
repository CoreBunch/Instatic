import type {
  FragmentInsertInput,
  FragmentInsertPlacement,
  FragmentPlanInput,
  ThemeApplyInput,
  ThemePlanInput,
} from '@core/plugin-sdk'

const FRAGMENT_PLACEMENTS: ReadonlySet<string> = new Set<FragmentInsertPlacement>(['after-selection', 'inside-selection', 'end'])

export function assertFragmentPlanInput(input: unknown, method: string): asserts input is FragmentPlanInput {
  if (!input || typeof input !== 'object') {
    throw new TypeError(`editor.fragments.${method}: input must be an object`)
  }
  if (!('fragment' in input) || input.fragment === undefined || input.fragment === null) {
    throw new TypeError(`editor.fragments.${method}: input.fragment is required`)
  }
  const sources = (input as { colorSources?: unknown }).colorSources
  if (sources !== undefined && (!sources || typeof sources !== 'object' || Array.isArray(sources)
    || Object.values(sources).some((v) => typeof v !== 'string'))) {
    throw new TypeError(`editor.fragments.${method}: input.colorSources must map colour slugs to colour slugs`)
  }
}

export function assertFragmentInsertInput(input: unknown): asserts input is FragmentInsertInput {
  assertFragmentPlanInput(input, 'insert')
  if ('assets' in input && input.assets !== undefined && input.assets !== 'background' && input.assets !== 'layout-only') {
    throw new TypeError('editor.fragments.insert: invalid assets mode')
  }
  const placement = (input as { placement?: unknown }).placement
  if (placement !== undefined && !FRAGMENT_PLACEMENTS.has(placement as string)) {
    throw new TypeError(`editor.fragments.insert: input.placement must be one of ${[...FRAGMENT_PLACEMENTS].join(', ')}`)
  }
  assertCommitOptions(input, 'insert')
}

export function assertThemePlanInput(input: unknown, method: string): asserts input is ThemePlanInput {
  if (!input || typeof input !== 'object') {
    throw new TypeError(`editor.fragments.${method}: input must be an object`)
  }
  if (!('theme' in input) || input.theme === undefined || input.theme === null) {
    throw new TypeError(`editor.fragments.${method}: input.theme is required`)
  }
}

export function assertThemeApplyInput(input: unknown): asserts input is ThemeApplyInput {
  assertThemePlanInput(input, 'applyTheme')
  assertCommitOptions(input, 'applyTheme')
}

/** The options an insert and a theme share: the media reader, progress, cancellation, toast. */
function assertCommitOptions(input: object, method: string): void {
  const value = input as Partial<Record<keyof FragmentInsertInput, unknown>>
  if (typeof value.readMediaBytes !== 'function') {
    throw new TypeError(`editor.fragments.${method}: input.readMediaBytes must be a function`)
  }
  if (value.onProgress !== undefined && typeof value.onProgress !== 'function') {
    throw new TypeError(`editor.fragments.${method}: input.onProgress must be a function`)
  }
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) {
    throw new TypeError(`editor.fragments.${method}: input.signal must be an AbortSignal`)
  }
  if (value.silent !== undefined && typeof value.silent !== 'boolean') {
    throw new TypeError(`editor.fragments.${method}: input.silent must be a boolean`)
  }
}
