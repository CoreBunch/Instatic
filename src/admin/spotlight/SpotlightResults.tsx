/**
 * SpotlightResults — ranked result list with group headers.
 *
 * Phase 2 additions:
 *   - Scope breadcrumb header when in a non-root scope
 *   - Arg mode UI: parent command breadcrumb + arg rows (completed + current)
 *     + filtered options for 'select' type args
 *   - Destructive confirm inline state on the highlighted row
 *   - activeScopeId prop for scope-aware search
 *
 * Phase 3 additions:
 *   - Async provider results rendered after static commands, grouped by
 *     provider label (SpotlightProvider.label).
 *   - SpotlightSkeleton shown 240 ms after any provider enters loadingProviders
 *     (per-provider — disappears as each provider completes).
 *   - RESULT_COUNT_CHANGED now reflects the full merged list length (static +
 *     async) so keyboard navigation covers async rows.
 */

import { use, useEffect, useRef, useState, type ReactNode } from 'react'
import { SpotlightInternalContext } from './spotlightContext'
import { SpotlightRow } from './SpotlightRow'
import { SpotlightSkeleton } from './SpotlightSkeleton'
import {
  getCappedResults,
  getOrderedAsyncGroups,
  getLoadingProviders,
  getMergedCommandList,
  rowId,
} from './spotlightSearch'
import { getScope } from './commandRegistry'
import { groupAccent } from './groupAccent'
import type { Command, CommandGroup } from './types'
import type { ScoredCommand } from './matcher'
import type { ArgModeState } from './state'
import styles from './Spotlight.module.css'
import { SearchSolidIcon } from 'pixel-art-icons/icons/search-solid'

// Stable empty fallbacks so hook dependency arrays don't see a new object
// reference on every render when the palette is closed.
const EMPTY_ASYNC_RESULTS: Record<string, Command[]> = {}
const EMPTY_LOADING_PROVIDERS: Set<string> = new Set()

const GROUP_LABELS: Record<CommandGroup, string> = {
  navigation: 'Navigation',
  editor: 'Editor',
  pages: 'Pages',
  content: 'Content',
  data: 'Data',
  media: 'Media',
  visualComponents: 'Visual Components',
  framework: 'Framework',
  plugins: 'Plugins',
  users: 'Users',
  account: 'Account',
  settings: 'Settings',
  preview: 'Preview',
  ai: 'AI Assistant',
  help: 'Help',
  recent: 'Recent',
  results: 'Results',
}

interface GroupedResults {
  group: CommandGroup
  label: string
  items: ScoredCommand[]
}

function groupResults(scored: ScoredCommand[]): GroupedResults[] {
  const map = new Map<CommandGroup, ScoredCommand[]>()
  for (const item of scored) {
    const g = item.command.group
    const existing = map.get(g)
    if (existing) {
      existing.push(item)
    } else {
      map.set(g, [item])
    }
  }
  const groups: GroupedResults[] = []
  for (const [group, items] of map) {
    groups.push({ group, label: GROUP_LABELS[group] ?? group, items })
  }
  return groups
}

// ─── Arg mode UI ──────────────────────────────────────────────────────────────

function ArgModeResults({
  argMode,
  query,
  highlightedIndex,
  onHighlightChange,
}: {
  argMode: ArgModeState
  query: string
  highlightedIndex: number
  onHighlightChange: (index: number) => void
}): ReactNode {
  const args = argMode.command.args ?? []
  const currentArg = args[argMode.argIndex]

  // For select type: filter options by query
  const filteredOptions = (() => {
    if (!currentArg || currentArg.type !== 'select' || !currentArg.options) return []
    const q = query.toLowerCase()
    if (!q) return [...currentArg.options]
    return currentArg.options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) ||
        opt.value.toLowerCase().includes(q),
    )
  })()

  return (
    <div className={styles.results} aria-label="Argument collection">
      {/* Breadcrumb: parent command title */}
      <div className={styles.argBreadcrumb}>
        <span className={styles.argBreadcrumbTitle}>{argMode.command.title}</span>
        <span className={styles.argBreadcrumbSeparator}>›</span>
        <span className={styles.argBreadcrumbCurrent}>
          {currentArg?.label ?? 'Done'}
        </span>
      </div>

      {/* Completed args (read-only rows) */}
      {args.slice(0, argMode.argIndex).map((arg) => (
        <div key={arg.id} className={styles.argCompletedRow}>
          <span className={styles.argRowGlyph}>↳</span>
          <span className={styles.argRowLabel}>{arg.label}</span>
          <span className={styles.argRowValue}>{argMode.values[arg.id] ?? ''}</span>
        </div>
      ))}

      {/* Current arg row (active) */}
      {currentArg && (
        <div className={styles.argCurrentRow}>
          <span className={styles.argRowGlyph}>↳</span>
          <span className={styles.argRowLabel}>{currentArg.label}</span>
          {currentArg.type !== 'select' && (
            <span className={styles.argRowValueActive}>
              {query || <span className={styles.argRowPlaceholder}>{currentArg.placeholder ?? 'Enter value…'}</span>}
            </span>
          )}
        </div>
      )}

      {/* For select type: show filtered options as selectable rows */}
      {currentArg?.type === 'select' && filteredOptions.length > 0 && (
        <div className={styles.argSelectOptions}>
          {filteredOptions.map((opt, idx) => (
            <div
              key={opt.value}
              className={`${styles.row} ${idx === highlightedIndex ? styles.rowHighlighted : ''}`}
              role="option"
              aria-selected={idx === highlightedIndex}
              onMouseEnter={() => onHighlightChange(idx)}
            >
              <span className={styles.rowIcon} />
              <span className={styles.rowContent}>
                <span className={styles.rowLabel}>{opt.label}</span>
                {opt.sublabel && (
                  <span className={styles.rowSublabel}>{opt.sublabel}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* For select type with no matches */}
      {currentArg?.type === 'select' && query && filteredOptions.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyStateText}>No options match "{query}"</p>
        </div>
      )}
    </div>
  )
}

// ─── Scope breadcrumb ─────────────────────────────────────────────────────────

function ScopeBreadcrumb({ scopeStack }: { scopeStack: Array<{ scopeId: string }> }): ReactNode {
  if (scopeStack.length <= 1) return null
  const parts = scopeStack.slice(1).map((frame) => {
    const scope = getScope(frame.scopeId)
    return scope?.title ?? frame.scopeId
  })
  return (
    <div className={styles.scopeBreadcrumb} aria-label={`Scope: ${parts.join(' › ')}`}>
      {parts.map((part, i) => (
        <span key={i} className={styles.scopeBreadcrumbPart}>
          {i > 0 && <span className={styles.scopeBreadcrumbSep}>›</span>}
          <span>{part}</span>
        </span>
      ))}
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

interface SpotlightResultsProps {
  listboxId: string
  highlightedIndex: number
  onHighlightChange: (index: number) => void
  onRun: (command: Command) => void
  activeScopeId: string
}

export function SpotlightResults({
  listboxId,
  highlightedIndex,
  onHighlightChange,
  onRun,
  activeScopeId,
}: SpotlightResultsProps): ReactNode {
  const ctx = use(SpotlightInternalContext)

  const query = ctx?.state.phase === 'open' ? ctx.state.query : ''
  const commandContext = ctx?.commandContext ?? null
  const argMode = ctx?.state.phase === 'open' ? ctx.state.argMode : null
  const pendingConfirm = ctx?.state.phase === 'open' ? ctx.state.pendingConfirm : null
  const scopeStack = ctx?.state.phase === 'open' ? ctx.state.scopeStack : []

  // Phase 3: async state — use stable module-level fallbacks so hook deps
  // don't see a new object/Set reference on every render when closed.
  const asyncResults = ctx?.state.phase === 'open'
    ? ctx.state.asyncResults
    : EMPTY_ASYNC_RESULTS
  const loadingProviders = ctx?.state.phase === 'open'
    ? ctx.state.loadingProviders
    : EMPTY_LOADING_PROVIDERS

  // ─── Skeleton delay ───────────────────────────────────────────────────────
  // Show skeleton only after 240 ms of loading to avoid a flash for fast
  // responses. Cleared on the next tick when loadingProviders empties.
  // Both branches go through setTimeout so no setState is called synchronously
  // inside the effect body (satisfies react-hooks/set-state-in-effect).

  const isLoading = loadingProviders.size > 0
  const [showSkeleton, setShowSkeleton] = useState(false)

  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => setShowSkeleton(true), 240)
      return () => clearTimeout(timer)
    } else {
      const timer = setTimeout(() => setShowSkeleton(false), 0)
      return () => clearTimeout(timer)
    }
  }, [isLoading])

  // ─── Static results ───────────────────────────────────────────────────────
  // Must be before any early returns to satisfy the Rules of Hooks.

  const capped = argMode ? [] : getCappedResults(query, commandContext, activeScopeId)

  // ─── Async results ────────────────────────────────────────────────────────

  const asyncGroups = argMode ? [] : getOrderedAsyncGroups(activeScopeId, asyncResults)

  // Providers still in-flight that haven't produced results yet → skeleton.
  const skeletonProviders = (showSkeleton && !argMode)
    ? getLoadingProviders(activeScopeId, loadingProviders, asyncResults)
    : []

  // ─── Merged flat list for keyboard-navigation index tracking ──────────────

  const mergedFlatList = argMode
    ? []
    : getMergedCommandList(query, commandContext, activeScopeId, asyncResults)
  const highlightedCommandId = mergedFlatList[highlightedIndex]?.id ?? null
  const resultsRef = useRef<HTMLDivElement>(null)

  // `dispatch` from useReducer is guaranteed stable, but the context value
  // itself is rebuilt on every state change. Only the dispatch reference is
  // captured here — including `ctx` in the deps below would cause an infinite
  // loop (each dispatch rebuilds ctx → effect re-fires → dispatches again).
  const dispatch = ctx?.dispatch

  // Notify parent when total result count changes (clamps highlighted index).
  // Deps intentionally exclude `ctx` — `dispatch` is referentially stable.
  // The reducer short-circuits when the clamped value is unchanged, so this
  // is a no-op once results stabilise.
  useEffect(() => {
    if (!dispatch || argMode) return
    dispatch({ type: 'RESULT_COUNT_CHANGED', count: mergedFlatList.length })
  }, [mergedFlatList.length, dispatch, argMode])

  useEffect(() => {
    if (!highlightedCommandId) return
    const selectedRow = resultsRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    )
    selectedRow?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightedCommandId])

  // ─── Scope transition direction ───────────────────────────────────────────
  // Tracks PUSH_SCOPE / POP_SCOPE to drive the slide animation on the results
  // container. Resets to null after the 120 ms keyframe completes.

  const prevScopeDepthRef = useRef(scopeStack.length)
  const [scopeDirection, setScopeDirection] = useState<'push' | 'pop' | null>(null)

  useEffect(() => {
    const prev = prevScopeDepthRef.current
    const next = scopeStack.length
    prevScopeDepthRef.current = next

    if (next === prev) return

    const dir = next > prev ? 'push' : 'pop'
    setScopeDirection(dir)
    const id = setTimeout(() => setScopeDirection(null), 120)
    return () => clearTimeout(id)
  }, [scopeStack.length])

  // ─── Arg mode ─────────────────────────────────────────────────────────────

  if (argMode) {
    return (
      <ArgModeResults
        argMode={argMode}
        query={query}
        highlightedIndex={highlightedIndex}
        onHighlightChange={onHighlightChange}
      />
    )
  }

  // ─── Guards ───────────────────────────────────────────────────────────────

  if (!ctx || ctx.state.phase !== 'open') return null

  // ─── Scope breadcrumb ─────────────────────────────────────────────────────

  const breadcrumb = scopeStack.length > 1 ? (
    <ScopeBreadcrumb scopeStack={scopeStack} />
  ) : null

  const hasStaticResults = capped.length > 0
  const hasAsyncResults = asyncGroups.length > 0

  // ─── Empty state ──────────────────────────────────────────────────────────
  // Only shown when there are genuinely no results and all providers have
  // finished (isLoading = false). While providers are still loading, we
  // either show nothing (< 240 ms) or the skeleton (≥ 240 ms).

  if (!hasStaticResults && !hasAsyncResults && !isLoading) {
    return (
      <div
        id={listboxId}
        role="listbox"
        aria-label="Command results"
        className={styles.results}
        data-scope-direction={scopeDirection ?? undefined}
      >
        {breadcrumb}
        <div className={styles.emptyState}>
          <span className={styles.emptyStateIcon} aria-hidden="true">
            <SearchSolidIcon size={32} />
          </span>
          {query ? (
            <p className={styles.emptyStateText}>
              No results for{' '}
              <span className={styles.emptyStateQuery}>"{query}"</span>
            </p>
          ) : (
            <p className={styles.emptyStateText}>No commands available</p>
          )}
        </div>
      </div>
    )
  }

  // ─── Static command groups ────────────────────────────────────────────────

  const groups = groupResults(capped)

  return (
    <div
      ref={resultsRef}
      id={listboxId}
      role="listbox"
      aria-label="Command results"
      className={styles.results}
      data-scope-direction={scopeDirection ?? undefined}
    >
      {breadcrumb}

      {/* Static built-in commands, grouped by CommandGroup */}
      {groups.map(({ group, label, items }) => (
        <div key={group} role="group" aria-label={label} data-accent={groupAccent(group)}>
          <div className={styles.groupHeader} aria-hidden="true">
            <span className={styles.groupBar} />
            <span className={styles.groupTitle}>{label}</span>
            <span className={styles.groupCount}>{items.length} items</span>
          </div>
          <div className={styles.groupItems}>
            {items.map((scoredCmd) => {
              const cmd = scoredCmd.command
              // Look up by id rather than reference — robust to fresh command
              // objects produced by dynamic factories like getPluginsCommands().
              const flatIdx = mergedFlatList.findIndex((c) => c.id === cmd.id)
              const isHighlighted = flatIdx === highlightedIndex
              const isConfirming = pendingConfirm === cmd.id

              return (
                <SpotlightRow
                  key={cmd.id}
                  id={rowId(cmd.id)}
                  command={cmd}
                  isHighlighted={isHighlighted}
                  isConfirming={isConfirming}
                  matchRanges={scoredCmd.matchRanges}
                  onHighlight={() => onHighlightChange(flatIdx)}
                  onSelect={() => onRun(cmd)}
                />
              )
            })}
          </div>
        </div>
      ))}

      {/* Async provider result groups — rendered in provider-definition order */}
      {asyncGroups.map(({ providerId, provider, commands }) => (
        <div key={providerId} role="group" aria-label={provider.label} data-accent={groupAccent('results')}>
          <div className={styles.groupHeader} aria-hidden="true">
            <span className={styles.groupBar} />
            <span className={styles.groupTitle}>{provider.label}</span>
            <span className={styles.groupCount}>{commands.length} items</span>
          </div>
          <div className={styles.groupItems}>
            {commands.map((cmd) => {
              const flatIdx = mergedFlatList.findIndex((c) => c.id === cmd.id)
              const isHighlighted = flatIdx === highlightedIndex
              const isConfirming = pendingConfirm === cmd.id

              return (
                <SpotlightRow
                  key={cmd.id}
                  id={rowId(cmd.id)}
                  command={cmd}
                  isHighlighted={isHighlighted}
                  isConfirming={isConfirming}
                  matchRanges={[]}
                  onHighlight={() => onHighlightChange(flatIdx)}
                  onSelect={() => onRun(cmd)}
                />
              )
            })}
          </div>
        </div>
      ))}

      {/* Skeleton groups for providers still in-flight (shown after 240 ms) */}
      {skeletonProviders.map((provider) => (
        <SpotlightSkeleton key={provider.id} label={provider.label} />
      ))}
    </div>
  )
}
