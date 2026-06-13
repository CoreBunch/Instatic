/**
 * useClassPickerSuggestions — derive the entire ClassPicker dropdown state
 * from the assigned-class set, the registry, and the typed query.
 *
 * Pure-derivation hook: reads `recordClassUsage`-backed history from
 * localStorage but writes nothing, dispatches no store actions, and runs
 * no effects. The component owns the *state inputs* (`query`,
 * `highlightedIndex`); we own everything that follows from them.
 *
 * Splitting these computations out of `ClassPicker.tsx` is what dropped its
 * cognitive complexity below the "critical" threshold and made the logic
 * testable without rendering React. See `useClassPickerSuggestions.test.ts`.
 */

import {
  classKindSelector,
  classifySelectorCreateInput,
  styleRuleSelector,
  type SelectorCreateInput,
  type StyleRule,
} from '@core/page-tree'
import {
  CLASS_USAGE_RECENT_LIMIT,
  readClassUsage,
  selectRecentAndFrequent,
} from '@site/preferences/classUsage'
import { isValidCssSelector } from '@site/store/styleRuleRename'
import {
  type SelectorSuggestionItem,
} from './selectorPickerModel'

/** Installation-local class-usage table — return type of `readClassUsage`. */
type ClassUsageMap = ReturnType<typeof readClassUsage>
import { rankBySuggestionScore } from './classPickerRanking'

// When the input is empty and Recent + Frequent (deduped) collectively surface
// at least this many classes, the dropdown skips the "All classes" section —
// the user already has plenty of relevant options without scrolling past every
// utility. Below the threshold we still pad with All so a near-empty history
// doesn't leave the dropdown sparse.
const SUFFICIENT_HISTORY_THRESHOLD = CLASS_USAGE_RECENT_LIMIT

interface ClassPickerSuggestionsInput {
  /** Every user-visible class in the site, regardless of node assignment. */
  allClasses: readonly StyleRule[]
  /** IDs already assigned to the active node (visible or hidden). */
  assignedIds: readonly string[]
  /** Ambient selector rows and unassigned class rows derived for this element. */
  selectorItems?: readonly SelectorSuggestionItem[]
  /** Trimmed but case-preserving query (used for exact-name matching). */
  query: string
  /** The Arrow-Up/Down highlight index; -1 means "no explicit selection". */
  highlightedIndex: number
  /**
   * Override `readClassUsage()` — useful for tests so we don't have to stub
   * localStorage. Production callers omit this.
   */
  readUsage?: () => ClassUsageMap
}

interface ClassPickerSuggestionsResult {
  trimmedQueryRaw: string
  isEmptyQuery: boolean

  /** Classes that aren't on the node yet — the universe the dropdown picks from. */
  candidates: StyleRule[]
  candidatesById: Map<string, StyleRule>

  /** Ranked filtered list when typing; same as `candidates` when empty. */
  filteredSuggestions: StyleRule[]
  /** Selector-kind suggestions (ambient selectors) filtered by the same query. */
  selectorSuggestions: SelectorSuggestionItem[]

  recentIds: readonly string[]
  frequentIds: readonly string[]
  remainingCandidates: StyleRule[]
  shouldShowAllSection: boolean
  surfacedCount: number

  /** Final flat order driving Arrow-Up/Down navigation. */
  flatNavIds: string[]

  /** Clamped index into `flatNavIds`; -1 when out of range. */
  effectiveHighlightedIndex: number
  hasArrowSelection: boolean
  /** Primitive — safe `useEffect` dep. */
  highlightedClassId: string | null
  highlightedSelectorItem: SelectorSuggestionItem | null
  /** Highlighted class's selector label, when any. */
  highlightedName: string | null

  /**
   * Exact-name match against ALL classes (assigned or not). Lets Enter add a
   * literal-name match instead of the first ranked suggestion.
   */
  exactMatchedClass: StyleRule | null
  exactMatchAlreadyAssigned: boolean
  exactMatchedSelectorItem: SelectorSuggestionItem | null
  createIntent: SelectorCreateInput
  createValidationError: string | null
  canCreateNew: boolean

  /**
   * Whether pressing Enter has a meaningful effect (Arrow highlight wins,
   * otherwise the typed input creates / adds an unassigned exact match).
   */
  hasSubmittableQuery: boolean
  submitTooltip: string
}

export function useClassPickerSuggestions(
  input: ClassPickerSuggestionsInput,
): ClassPickerSuggestionsResult {
  const {
    allClasses,
    assignedIds,
    selectorItems = [],
    query,
    highlightedIndex,
    readUsage = readClassUsage,
  } = input

  const trimmedQueryRaw = query.trim()
  const trimmedQuery = trimmedQueryRaw.toLowerCase()
  const isEmptyQuery = trimmedQuery.length === 0
  const createIntent = classifySelectorCreateInput(trimmedQueryRaw)

  const candidates = allClasses.filter((c) => !assignedIds.includes(c.id))
  const candidatesById = new Map(candidates.map((c) => [c.id, c]))

  // Empty query → unfiltered candidates; typed query → ranked relevance.
  // Ranking tiers (in classPickerRanking):
  //   4 = exact name | 3 = prefix | 2 = word boundary | 1 = substring
  // shorter names win within a tier, then alphabetical.
  const classSearchQuery = createIntent.kind === 'class'
    ? createIntent.name.toLowerCase()
    : trimmedQuery
  const filteredSuggestions = isEmptyQuery
    ? candidates
    : rankBySuggestionScore(candidates, classSearchQuery)
  const selectorSuggestions = isEmptyQuery
    ? selectorItems.slice()
    : rankSelectorSuggestions(selectorItems, trimmedQuery)

  // Empty-query layout: surface Recent + Frequent first, then optionally an
  // "All classes" section so fresh sites with sparse history stay browsable.
  const usage: ClassUsageMap = isEmptyQuery ? readUsage() : {}
  const { recent: recentIds, frequent: frequentIds } = isEmptyQuery
    ? selectRecentAndFrequent(usage, candidates.map((c) => c.id))
    : { recent: [] as string[], frequent: [] as string[] }
  const surfacedSet = new Set<string>([...recentIds, ...frequentIds])
  const surfacedCount = surfacedSet.size
  const remainingCandidates = candidates.filter((c) => !surfacedSet.has(c.id))
  const shouldShowAllSection =
    isEmptyQuery && (surfacedCount === 0 || surfacedCount < SUFFICIENT_HISTORY_THRESHOLD)

  // Flat list of class IDs in their final display order (Recent → Frequent →
  // All when input is empty, ranked filteredSuggestions when typing).
  const flatNavIds: string[] = isEmptyQuery
    ? [
        ...recentIds,
        ...frequentIds,
        ...(shouldShowAllSection ? remainingCandidates.map((c) => c.id) : []),
        ...selectorSuggestions.map((item) => item.rule.id),
      ]
    : [
        ...filteredSuggestions.map((c) => c.id),
        ...selectorSuggestions.map((item) => item.rule.id),
      ]

  // Clamp the stored highlight to the live suggestion list rather than
  // "fixing it up" through a setState-in-effect.
  const effectiveHighlightedIndex =
    highlightedIndex >= 0 && highlightedIndex < flatNavIds.length ? highlightedIndex : -1
  const hasArrowSelection = effectiveHighlightedIndex >= 0
  const highlightedClassId = hasArrowSelection
    ? candidatesById.get(flatNavIds[effectiveHighlightedIndex] ?? '')?.id ?? null
    : null
  const highlightedClass = highlightedClassId ? candidatesById.get(highlightedClassId) ?? null : null
  const selectorSuggestionsById = new Map(selectorSuggestions.map((item) => [item.rule.id, item]))
  const highlightedSelectorItem = hasArrowSelection
    ? selectorSuggestionsById.get(flatNavIds[effectiveHighlightedIndex] ?? '') ?? null
    : null
  const highlightedName = highlightedClass ? styleRuleSelector(highlightedClass) : null

  // Exact-name match against ALL user-visible classes (including ones already
  // assigned). Drives the Enter-with-typed-input path: typing an existing
  // unassigned name adds that class; typing something new creates and adds it.
  const exactMatchedClass = !isEmptyQuery && createIntent.kind === 'class'
    ? allClasses.find((c) => c.name === createIntent.name) ?? null
    : null
  const exactMatchAlreadyAssigned =
    exactMatchedClass !== null && assignedIds.includes(exactMatchedClass.id)
  const exactMatchedSelectorItem = !isEmptyQuery && createIntent.kind === 'ambient'
    ? selectorItems.find((item) => styleRuleSelector(item.rule) === createIntent.selector) ?? null
    : null
  const createValidationError = createIntent.kind === 'ambient' && !isValidCssSelector(createIntent.selector)
    ? `Invalid CSS selector: ${createIntent.selector}`
    : null
  const canCreateNew =
    !isEmptyQuery
    && createIntent.kind !== 'empty'
    && createValidationError === null
    && exactMatchedClass === null
    && exactMatchedSelectorItem === null

  // Enter has a meaningful effect when one of these is true; otherwise it's
  // a no-op (empty input, or query matches an already-assigned class with
  // no Arrow-nav highlight).
  const hasSubmittableQuery = hasArrowSelection
    ? highlightedClassId !== null || (highlightedSelectorItem !== null && !highlightedSelectorItem.disabled)
    : canCreateNew
      || (exactMatchedClass !== null && !exactMatchAlreadyAssigned)
      || (exactMatchedSelectorItem !== null && !exactMatchedSelectorItem.disabled)

  const submitTooltip = deriveSubmitTooltip({
    hasArrowSelection,
    highlightedName,
    highlightedSelectorItem,
    exactMatchedSelectorItem,
    canCreateNew,
    createValidationError,
    createIntent,
    trimmedQueryRaw,
    exactMatchedClass,
    exactMatchAlreadyAssigned,
  })

  return {
    trimmedQueryRaw,
    isEmptyQuery,
    candidates,
    candidatesById,
    filteredSuggestions,
    selectorSuggestions,
    recentIds,
    frequentIds,
    remainingCandidates,
    shouldShowAllSection,
    surfacedCount,
    flatNavIds,
    effectiveHighlightedIndex,
    hasArrowSelection,
    highlightedClassId,
    highlightedSelectorItem,
    highlightedName,
    exactMatchedClass,
    exactMatchAlreadyAssigned,
    exactMatchedSelectorItem,
    createIntent,
    createValidationError,
    canCreateNew,
    hasSubmittableQuery,
    submitTooltip,
  }
}

function rankSelectorSuggestions(
  items: readonly SelectorSuggestionItem[],
  query: string,
): SelectorSuggestionItem[] {
  if (!query) return items.slice()
  const scored: Array<{ item: SelectorSuggestionItem; score: number; label: string }> = []
  for (const item of items) {
    const label = styleRuleSelector(item.rule)
    const score = scoreSelectorLabel(label, query)
    if (score > 0) scored.push({ item, score, label })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.item.disabled !== b.item.disabled) return a.item.disabled ? 1 : -1
    if (a.label.length !== b.label.length) return a.label.length - b.label.length
    return a.label.localeCompare(b.label)
  })
  return scored.map((entry) => entry.item)
}

function scoreSelectorLabel(label: string, query: string): number {
  const haystack = label.toLowerCase()
  if (haystack === query) return 4
  if (haystack.startsWith(query) || haystack.startsWith(`.${query}`)) return 3
  if (haystack.includes(` ${query}`) || haystack.includes(`.${query}`) || haystack.includes(`-${query}`)) {
    return 2
  }
  return haystack.includes(query) ? 1 : 0
}

/**
 * Build the submit-button tooltip from the current input + selection state.
 *
 * Priority mirrors the picker's submit logic:
 *   1. Arrow-key highlight wins — describe adding the highlighted class.
 *   2. Otherwise the typed input is the source of truth: a brand-new name
 *      becomes a "Create class" hint; an exact match becomes "Add class"
 *      (or "already on this element" when it's already assigned).
 *   3. Empty input falls back to the static instructional copy.
 */
function deriveSubmitTooltip(args: {
  hasArrowSelection: boolean
  highlightedName: string | null
  highlightedSelectorItem: SelectorSuggestionItem | null
  exactMatchedSelectorItem: SelectorSuggestionItem | null
  canCreateNew: boolean
  createValidationError: string | null
  createIntent: SelectorCreateInput
  trimmedQueryRaw: string
  exactMatchedClass: StyleRule | null
  exactMatchAlreadyAssigned: boolean
}): string {
  const {
    hasArrowSelection,
    highlightedName,
    highlightedSelectorItem,
    exactMatchedSelectorItem,
    canCreateNew,
    createValidationError,
    createIntent,
    trimmedQueryRaw,
    exactMatchedClass,
    exactMatchAlreadyAssigned,
  } = args
  if (createValidationError) return createValidationError
  if (hasArrowSelection && highlightedName) return `Add class “${highlightedName}”`
  if (hasArrowSelection && highlightedSelectorItem) {
    if (highlightedSelectorItem.disabled) {
      return highlightedSelectorItem.disabledReason ?? 'Selector does not match this element'
    }
    return `Edit selector “${styleRuleSelector(highlightedSelectorItem.rule)}”`
  }
  if (exactMatchedClass && !exactMatchAlreadyAssigned) return `Add class “${styleRuleSelector(exactMatchedClass)}”`
  if (exactMatchedClass && exactMatchAlreadyAssigned) {
    return `“${styleRuleSelector(exactMatchedClass)}” is already on this element`
  }
  if (exactMatchedSelectorItem) {
    if (exactMatchedSelectorItem.disabled) {
      return exactMatchedSelectorItem.disabledReason ?? 'Selector does not match this element'
    }
    return `Edit selector “${styleRuleSelector(exactMatchedSelectorItem.rule)}”`
  }
  if (canCreateNew && trimmedQueryRaw) {
    if (createIntent.kind === 'ambient') return `Create selector “${createIntent.selector}”`
    if (createIntent.kind === 'class') return `Create class “${classKindSelector(createIntent.name)}”`
  }
  return 'Type a class name or selector to add or create'
}
