/**
 * Per-action handlers for the spotlight reducer.
 *
 * The reducer in `state.ts` handles the three phase-transition actions (OPEN /
 * CLOSE / TOGGLE) directly, then delegates every other action — all of which
 * require `phase === 'open'` — to `applyOpenAction` below. Each case is a
 * one-line call to a small, named handler so adding a new action is a two-line
 * edit (helper + dispatcher case) instead of growing one giant switch.
 *
 * All handlers are pure: same input → same output, no side effects, no closures
 * over external state. They take a `SpotlightOpenState` and return a
 * `SpotlightState` (almost always still open; CLOSE is handled by the reducer
 * itself).
 */

import type { Command } from './types'
import type {
  SpotlightAction,
  SpotlightOpenState,
  SpotlightState,
} from './state'

/** Action variants that are only valid while `state.phase === 'open'`. */
type OpenOnlyAction = Exclude<
  SpotlightAction,
  { type: 'OPEN' | 'CLOSE' | 'TOGGLE' }
>

// ─── Query / highlight ────────────────────────────────────────────────────────

function setQuery(state: SpotlightOpenState, query: string): SpotlightState {
  return { ...state, query, highlightedIndex: 0 }
}

function setHighlighted(state: SpotlightOpenState, index: number): SpotlightState {
  return { ...state, highlightedIndex: index }
}

function shiftHighlight(state: SpotlightOpenState, delta: number): SpotlightState {
  return {
    ...state,
    highlightedIndex: Math.max(0, state.highlightedIndex + delta),
  }
}

function clampHighlight(state: SpotlightOpenState, count: number): SpotlightState {
  // Clamp highlighted index when result count shrinks. Critical: return the
  // SAME state reference when nothing changes — otherwise consumers that
  // re-dispatch on every render (e.g. SpotlightResults' count-sync effect)
  // cause an infinite re-render loop. The reducer is the single place we can
  // guarantee referential stability here.
  const next = Math.min(state.highlightedIndex, Math.max(0, count - 1))
  if (next === state.highlightedIndex) return state
  return { ...state, highlightedIndex: next }
}

// ─── Scope stack ──────────────────────────────────────────────────────────────

function pushScope(
  state: SpotlightOpenState,
  scopeId: string,
  pendingArgs: Record<string, string> | undefined,
): SpotlightState {
  return {
    ...state,
    query: '',
    highlightedIndex: 0,
    scopeStack: [
      ...state.scopeStack,
      { scopeId, pendingArgs: pendingArgs ?? {} },
    ],
    argMode: null,
    pendingConfirm: null,
    // Clear async state on scope change so stale results from the previous
    // scope don't bleed into the new one.
    asyncResults: {},
    loadingProviders: new Set(),
  }
}

function popScope(state: SpotlightOpenState): SpotlightState {
  if (state.scopeStack.length <= 1) return state
  return {
    ...state,
    query: '',
    highlightedIndex: 0,
    scopeStack: state.scopeStack.slice(0, -1),
    argMode: null,
    pendingConfirm: null,
    asyncResults: {},
    loadingProviders: new Set(),
  }
}

// ─── Async providers ──────────────────────────────────────────────────────────

function setAsyncResults(
  state: SpotlightOpenState,
  providerId: string,
  results: Command[],
): SpotlightState {
  const loadingProviders = new Set(state.loadingProviders)
  loadingProviders.delete(providerId)
  return {
    ...state,
    asyncResults: { ...state.asyncResults, [providerId]: results },
    loadingProviders,
  }
}

function setLoadingProvider(
  state: SpotlightOpenState,
  providerId: string,
  loading: boolean,
): SpotlightState {
  const loadingProviders = new Set(state.loadingProviders)
  if (loading) loadingProviders.add(providerId)
  else loadingProviders.delete(providerId)
  return { ...state, loadingProviders }
}

function asyncReset(state: SpotlightOpenState): SpotlightState {
  return { ...state, asyncResults: {}, loadingProviders: new Set() }
}

// ─── Arg mode ─────────────────────────────────────────────────────────────────

function enterArgMode(state: SpotlightOpenState, command: Command): SpotlightState {
  if (!command.args || command.args.length === 0) return state
  return {
    ...state,
    query: '',
    highlightedIndex: 0,
    argMode: { command, argIndex: 0, values: {} },
    pendingConfirm: null,
  }
}

function saveArgAndAdvance(
  state: SpotlightOpenState,
  argId: string,
  value: string,
): SpotlightState {
  if (!state.argMode) return state
  const { command, argIndex, values } = state.argMode
  // Always advance. If `nextIndex === args.length` the caller is responsible
  // for running the command and dispatching EXIT_ARG_MODE; we keep argMode
  // alive with the final values so the caller can read them.
  return {
    ...state,
    query: '',
    highlightedIndex: 0,
    argMode: {
      command,
      argIndex: argIndex + 1,
      values: { ...values, [argId]: value },
    },
  }
}

function backArg(state: SpotlightOpenState): SpotlightState {
  if (!state.argMode) return state
  const { argIndex } = state.argMode
  const argMode = argIndex <= 0 ? null : { ...state.argMode, argIndex: argIndex - 1 }
  return { ...state, query: '', highlightedIndex: 0, argMode }
}

function exitArgMode(state: SpotlightOpenState): SpotlightState {
  return { ...state, query: '', highlightedIndex: 0, argMode: null }
}

// ─── Destructive confirm ──────────────────────────────────────────────────────

function setPendingConfirm(
  state: SpotlightOpenState,
  commandId: string,
): SpotlightState {
  return { ...state, pendingConfirm: commandId }
}

function clearPendingConfirm(state: SpotlightOpenState): SpotlightState {
  return { ...state, pendingConfirm: null }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Routes an open-only action to the matching handler. The reducer guarantees
 * `state.phase === 'open'` before calling this, so handlers can assume an
 * open state. New actions: add a case here and a matching handler above.
 */
export function applyOpenAction(
  state: SpotlightOpenState,
  action: OpenOnlyAction,
): SpotlightState {
  switch (action.type) {
    case 'SET_QUERY': return setQuery(state, action.query)
    case 'SET_HIGHLIGHTED': return setHighlighted(state, action.index)
    case 'HIGHLIGHT_NEXT': return shiftHighlight(state, +1)
    case 'HIGHLIGHT_PREV': return shiftHighlight(state, -1)
    case 'PUSH_SCOPE': return pushScope(state, action.scopeId, action.pendingArgs)
    case 'POP_SCOPE': return popScope(state)
    case 'SET_ASYNC_RESULTS':
      return setAsyncResults(state, action.providerId, action.results)
    case 'SET_LOADING_PROVIDER':
      return setLoadingProvider(state, action.providerId, action.loading)
    case 'ASYNC_RESET': return asyncReset(state)
    case 'RESULT_COUNT_CHANGED': return clampHighlight(state, action.count)
    case 'ENTER_ARG_MODE': return enterArgMode(state, action.command)
    case 'SAVE_ARG_AND_ADVANCE':
      return saveArgAndAdvance(state, action.argId, action.value)
    case 'BACK_ARG': return backArg(state)
    case 'EXIT_ARG_MODE': return exitArgMode(state)
    case 'SET_PENDING_CONFIRM': return setPendingConfirm(state, action.commandId)
    case 'CLEAR_PENDING_CONFIRM': return clearPendingConfirm(state)
  }
}
