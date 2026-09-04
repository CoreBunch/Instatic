/**
 * Spotlight — command palette dialog overlay.
 *
 * Mounted via a React portal to document.body. Lazy-loaded chunk (first ⌘K).
 *
 * Accessibility:
 *   - role="dialog", aria-modal="true", aria-label="Command palette"
 *   - Input has aria-controls + aria-activedescendant (updated on navigation)
 *   - Result list is role="listbox"; rows are role="option" with aria-selected
 *   - Focus trapped inside; focus restored to previous element on close
 *   - Backdrop click closes
 *
 * Keyboard:
 *   ↑↓     Navigate highlight
 *   Enter  Run highlighted command (first Enter on destructive = confirm prompt,
 *          second Enter = run; Enter in arg mode = advance/complete)
 *   Tab/→  Drill into scope if command returns { pushScope }
 *   ←/⌫   Pop scope when at start of empty input (in arg mode: back one arg)
 *   Esc    Handled by SpotlightProvider (exit arg mode → clear confirm → clear
 *          query → close)
 */

import {
  use,
  useEffect,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { SpotlightInternalContext } from './spotlightContext'
import { SpotlightResults } from './SpotlightResults'
import { SpotlightFooter } from './SpotlightFooter'
import {
  computeHighlightedRowId,
  getCommandAtIndex,
} from './spotlightSearch'
import { SearchSolidIcon } from 'pixel-art-icons/icons/search-solid'
import { Kbd } from '@ui/components/Kbd'
import styles from './Spotlight.module.css'
import type { Command, ScopeFrame } from './types'

// Stable empty fallbacks used when the palette is closed, so hook dependency
// arrays don't see a new object reference on every render.
const EMPTY_ASYNC_RESULTS: Record<string, Command[]> = {}
const EMPTY_SCOPE_STACK: ScopeFrame[] = []

// Stable id for the listbox — consistent across renders; simpler than useId()
// and required by the a11y spec (aria-controls="spotlight-results").
const LISTBOX_ID = 'spotlight-results'

export interface SpotlightProps {
  /** True during the 80 ms close animation (component stays mounted, fades out). */
  isClosing?: boolean
}

export function Spotlight({ isClosing = false }: SpotlightProps): ReactNode {
  const ctx = use(SpotlightInternalContext)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previouslyFocusedRef = useRef<Element | null>(null)

  const isOpen = ctx?.state.phase === 'open'
  const listboxId = LISTBOX_ID
  const query = ctx?.state.phase === 'open' ? ctx.state.query : ''
  const highlightedIndex = ctx?.state.phase === 'open' ? ctx.state.highlightedIndex : 0
  const scopeStack = ctx?.state.phase === 'open' ? ctx.state.scopeStack : EMPTY_SCOPE_STACK
  const argMode = ctx?.state.phase === 'open' ? ctx.state.argMode : null
  const pendingConfirm = ctx?.state.phase === 'open' ? ctx.state.pendingConfirm : null
  const commandContext = ctx?.commandContext ?? null
  // Phase 3: async provider results for keyboard-navigation index tracking.
  const asyncResults = ctx?.state.phase === 'open' ? ctx.state.asyncResults : EMPTY_ASYNC_RESULTS

  // Active scope id for scope-aware search.
  const activeScopeId = scopeStack.length > 0
    ? scopeStack[scopeStack.length - 1]!.scopeId
    : 'root'

  // Compute the highlighted row id for aria-activedescendant.
  // Phase 3: pass asyncResults so the index covers provider result rows too.
  const highlightedRowId = isOpen
    ? computeHighlightedRowId(
        query, commandContext, highlightedIndex,
        argMode ? undefined : activeScopeId,
        argMode ? undefined : asyncResults,
      )
    : null

  // ─── Focus management: capture on open, restore on close ─────────────────

  useEffect(() => {
    if (!isOpen) return undefined
    previouslyFocusedRef.current = document.activeElement
    const rafId = requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    return () => {
      cancelAnimationFrame(rafId)
      ;(previouslyFocusedRef.current as HTMLElement | null)?.focus()
    }
  }, [isOpen])

  // ─── Focus trap ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return undefined
    const dialog = dialogRef.current
    if (!dialog) return undefined

    function onFocusTrap(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Tab') return
      const focusable = dialog!.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    dialog.addEventListener('keydown', onFocusTrap)
    return () => dialog.removeEventListener('keydown', onFocusTrap)
  }, [isOpen])

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const dispatch = ctx?.dispatch
  const runCommand = ctx?.runCommand
  const runCommandWithArgs = ctx?.runCommandWithArgs

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    dispatch?.({ type: 'SET_QUERY', query: e.target.value })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!dispatch || !runCommand || !runCommandWithArgs) return

    // ── Arg mode keyboard ─────────────────────────────────────────────────
    if (argMode) {
      const args = argMode.command.args ?? []
      const currentArg = args[argMode.argIndex]
      if (!currentArg) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          dispatch({ type: 'HIGHLIGHT_NEXT' })
          break

        case 'ArrowUp':
          e.preventDefault()
          dispatch({ type: 'HIGHLIGHT_PREV' })
          break

        case 'Enter': {
          e.preventDefault()

          // For select type: get highlighted option value
          let value = query
          if (currentArg.type === 'select' && currentArg.options) {
            const filtered = currentArg.options.filter(
              (opt) => !query || opt.label.toLowerCase().includes(query.toLowerCase()) ||
                opt.value.toLowerCase().includes(query.toLowerCase())
            )
            const highlighted = filtered[highlightedIndex]
            if (highlighted) value = highlighted.value
            else if (filtered.length > 0) value = filtered[0]!.value
          }

          selectArg(value)
          break
        }

        case 'Backspace': {
          if (query === '') {
            e.preventDefault()
            dispatch({ type: 'BACK_ARG' })
          }
          break
        }

        case 'ArrowLeft': {
          if (query === '') {
            e.preventDefault()
            dispatch({ type: 'BACK_ARG' })
          }
          break
        }

        default:
          break
      }
      return
    }

    // ── Normal / scope mode keyboard ──────────────────────────────────────
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        dispatch({ type: 'HIGHLIGHT_NEXT' })
        break

      case 'ArrowUp':
        e.preventDefault()
        dispatch({ type: 'HIGHLIGHT_PREV' })
        break

      case 'Enter': {
        e.preventDefault()
        // Phase 3: pass asyncResults so Enter works on provider result rows.
        const cmd = getCommandAtIndex(query, commandContext, highlightedIndex, activeScopeId, asyncResults)
        if (!cmd) break

        // Destructive confirm: first Enter → show confirm; second → run
        if (cmd.destructive && pendingConfirm !== cmd.id) {
          dispatch({ type: 'SET_PENDING_CONFIRM', commandId: cmd.id })
          break
        }

        // Clear any existing confirm state
        if (pendingConfirm) {
          dispatch({ type: 'CLEAR_PENDING_CONFIRM' })
        }

        void runCommand(cmd)
        break
      }

      case 'Tab':
      case 'ArrowRight': {
        e.preventDefault()
        // Phase 3: pass asyncResults so Tab/→ works on provider result rows.
        const cmd = getCommandAtIndex(query, commandContext, highlightedIndex, activeScopeId, asyncResults)
        if (!cmd) break
        // If the command has args, enter arg mode
        if (cmd.args && cmd.args.length > 0) {
          dispatch({ type: 'ENTER_ARG_MODE', command: cmd })
          break
        }
        // If the command's run returns a scope push, handle it by running (run() will pushScope)
        // Try to drill into scope: run the command (it may call ctx.pushScope)
        void runCommand(cmd)
        break
      }

      case 'ArrowLeft':
      case 'Backspace': {
        // Pop scope when at start of empty query
        if (e.key === 'ArrowLeft' || query === '') {
          if (scopeStack.length > 1) {
            e.preventDefault()
            dispatch({ type: 'POP_SCOPE' })
          }
        }
        // Clear pending confirm on any navigation
        if (pendingConfirm) {
          dispatch({ type: 'CLEAR_PENDING_CONFIRM' })
        }
        break
      }

      default:
        // Typing clears any pending confirm
        if (pendingConfirm && e.key.length === 1) {
          dispatch({ type: 'CLEAR_PENDING_CONFIRM' })
        }
        break
    }
  }

  const handleHighlightChange = (index: number) => {
    dispatch?.({ type: 'SET_HIGHLIGHTED', index })
  }

  const handleRun = (cmd: Parameters<NonNullable<typeof runCommand>>[0]) => {
    if (!runCommand || !dispatch) return
    if (cmd.destructive && pendingConfirm !== cmd.id) {
      dispatch({ type: 'SET_PENDING_CONFIRM', commandId: cmd.id })
      return
    }
    if (pendingConfirm) dispatch({ type: 'CLEAR_PENDING_CONFIRM' })
    void runCommand(cmd)
  }

  // ─── Arg selection (shared by keyboard Enter + mouse click) ────────────────
  // Saves the given arg value and either advances to the next arg or, when the
  // last arg is filled, exits arg mode and runs the command.
  const selectArg = (value: string) => {
    if (!dispatch || !runCommandWithArgs || !argMode) return
    const args = argMode.command.args ?? []
    const currentArg = args[argMode.argIndex]
    if (!currentArg) return
    const isLastArg = argMode.argIndex >= args.length - 1
    if (isLastArg) {
      const fullArgs = { ...argMode.values, [currentArg.id]: value }
      dispatch({ type: 'EXIT_ARG_MODE' })
      void runCommandWithArgs(argMode.command, fullArgs)
    } else {
      dispatch({ type: 'SAVE_ARG_AND_ADVANCE', argId: currentArg.id, value })
    }
  }

  // Derive input placeholder
  const placeholder = (() => {
    if (argMode) {
      const args = argMode.command.args ?? []
      const currentArg = args[argMode.argIndex]
      if (currentArg) return currentArg.placeholder ?? currentArg.label
    }
    if (scopeStack.length > 1) {
      const activeScope = ctx?.state.phase === 'open'
        ? scopeStack[scopeStack.length - 1]
        : null
      if (activeScope?.scopeId) {
        // Look up scope placeholder from registry
        return 'Type to search…'
      }
    }
    return 'Type a command or search…'
  })()

  // ─── Guard — render nothing when fully closed (not during close animation) ─

  if (!ctx || (!isOpen && !isClosing)) return null

  // ─── Render ───────────────────────────────────────────────────────────────

  const dialogState = isClosing ? 'closing' : 'open'

  return createPortal(
    <div
      className={styles.backdrop}
      data-state={dialogState}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isClosing) {
          dispatch?.({ type: 'CLOSE' })
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={styles.panel}
        data-state={dialogState}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Screen-reader live region for transient announcements ─────── */}
        {/* Announces destructive confirm prompts to assistive technology. */}
        <div
          className={styles.announceRegion}
          aria-live="assertive"
          aria-atomic="true"
          role="alert"
        >
          {pendingConfirm ? 'Press Enter again to confirm' : ''}
        </div>

        {/* ── Input row ─────────────────────────────────────────────────── */}
        <div className={styles.inputRow}>
          <span className={styles.searchIcon} aria-hidden="true">
            <SearchSolidIcon size={18} />
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-activedescendant={highlightedRowId ?? undefined}
            aria-label={argMode ? `Enter ${argMode.command.args?.[argMode.argIndex]?.label ?? 'value'}` : 'Search commands'}
            aria-autocomplete="list"
            placeholder={placeholder}
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <Kbd className={styles.escHint}>Esc</Kbd>
        </div>

        {/* ── Results ───────────────────────────────────────────────────── */}
        <SpotlightResults
          listboxId={listboxId}
          highlightedIndex={highlightedIndex}
          onHighlightChange={handleHighlightChange}
          onSelectArg={selectArg}
          onRun={handleRun}
          activeScopeId={activeScopeId}
        />

        {/* ── Footer ────────────────────────────────────────────────────── */}
        <SpotlightFooter isArgMode={!!argMode} hasScopeStack={scopeStack.length > 1} />
      </div>
    </div>,
    document.body,
  )
}
