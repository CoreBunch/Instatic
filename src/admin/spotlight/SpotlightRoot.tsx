/**
 * SpotlightRoot — context + global ⌘K/Ctrl+K listener.
 *
 * Responsibilities:
 *   1. Owns the spotlight state (useReducer).
 *   2. Registers the global keydown listener for ⌘K / Ctrl+K.
 *   3. Esc closes (or clears query if non-empty), per plan §2.
 *   4. Provides SpotlightContext to all children.
 *   5. Lazily renders <Spotlight /> via React.lazy + Suspense (no-op fallback)
 *      so the main dialog chunk is only downloaded on first open.
 *   6. Builds CommandContext from current workspace/user.
 *   7. Executes commands via runCommand() / runCommandWithArgs().
 *
 * Phase 2:
 *   - Live editor context subscription via lazy import of @site/store/store.
 *     Subscribed with subscribeWithSelector while spotlight is open on the
 *     site workspace; dropped on close or workspace change.
 *   - ESC now also exits arg mode and clears pending confirm.
 *
 * Phase 3:
 *   - ProviderRunner wired via useRef: fires async providers when the palette
 *     is open and the query / scope changes. Aborted and cache-cleared on close.
 *
 * Contexts live in spotlightContext.ts (separate .ts file) to comply with
 * react-refresh/only-export-components (TSX files must only export components).
 *
 * Placement: inside AuthenticatedAdmin in AdminEntry.tsx, above AdminSessionProvider.
 * Navigation: uses useAdminNavigate() which requires Router context.
 */

import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { recordTelemetryRun } from './telemetry'
import { useLocation } from '@admin/lib/routing'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { useStepUp } from '@admin/shared/StepUp'
import { spotlightReducer, initialState } from './state'
import { ProviderRunner } from './providerRunner'
import type { AdminWorkspace } from '@admin/workspace'
import type { Command, CommandContext, CommandRunContext } from './types'
import type { SpotlightControls } from './spotlightControls'
import { recordRecentCommand } from './recentStore'
import { SpotlightContext, SpotlightInternalContext } from './spotlightContext'
import type { SpotlightInternalContextValue } from './spotlightContext'
import { getKeybindingForCommand } from './keybindings'
import { findMatchingShortcutCommand } from './shortcutDispatch'

// ─── Lazy dialog chunk ────────────────────────────────────────────────────────
// Defined at module level so React.lazy doesn't recreate the wrapper on each
// render (that would break Suspense caching of the loaded chunk).

const LazySpotlight = lazy(() =>
  import('./Spotlight').then((m) => ({ default: m.Spotlight })),
)

// ─── Workspace detection ──────────────────────────────────────────────────────

/**
 * Mirrors the `section` each route hands `<AdminEntry>` in `router.tsx`. Falls
 * back to `'dashboard'` (not `'site'`) for anything unrecognized, matching the
 * router's own catch-all (`/admin/*` → `/admin/dashboard`) — a stray/unknown
 * path is the admin home, not the Site editor. Getting this right matters
 * beyond navigation labels: `filterCommands` gates every `site`-scoped
 * command (layers, panels, framework, preview, …) on `ctx.workspace === 'site'`,
 * so misclassifying, say, `/admin/dashboard` as `'site'` would both surface
 * those commands where there's no open editor to run them against AND make a
 * command like "Take the editor tour" think it's already on the Site
 * workspace instead of queuing its cross-workspace navigate.
 */
function workspaceFromPathname(pathname: string): AdminWorkspace {
  if (pathname.startsWith('/admin/content')) return 'content'
  if (pathname.startsWith('/admin/data')) return 'data'
  if (pathname.startsWith('/admin/media')) return 'media'
  // Plugin *pages* (`/admin/plugins/:pluginId/:pageId`) are a distinct
  // workspace from the plugin manager list (`/admin/plugins`) — check the
  // more specific path first.
  if (/^\/admin\/plugins\/[^/]+\/[^/]+/.test(pathname)) return 'pluginPage'
  if (pathname.startsWith('/admin/plugins')) return 'plugins'
  if (pathname.startsWith('/admin/users')) return 'users'
  if (pathname.startsWith('/admin/ai')) return 'ai'
  if (pathname.startsWith('/admin/account')) return 'account'
  if (pathname.startsWith('/admin/site')) return 'site'
  return 'dashboard'
}

// ─── Editor context snapshot type ────────────────────────────────────────────

type EditorCtxSnapshot = NonNullable<CommandContext['editor']>

// ─── SpotlightRoot ────────────────────────────────────────────────────────────

export function SpotlightRoot({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(spotlightReducer, initialState)
  const navigate = useAdminNavigate()
  const user = useCurrentAdminUser()
  const { pathname } = useLocation()
  // SpotlightRoot sits inside StepUpProvider (see AdminEntry.tsx) so
  // it can hand `runStepUp` to every command via CommandRunContext.
  // Without this, palette-invoked actions hitting step-up-gated endpoints
  // would surface a raw `step_up_required` error instead of opening the
  // re-auth dialog.
  const { runStepUp } = useStepUp()

  // ─── Derived state (declared once, used throughout) ───────────────────────

  const isOpen = state.phase === 'open'

  // ─── Close animation (80 ms) ──────────────────────────────────────────────
  // Keep the dialog mounted during the fade-out so the CSS animation can play.
  // dialogVisible = true  → render the portal (even when closing)
  // isAnimatingClose = true → pass isClosing=true so the portal shows closing anim

  const [dialogVisible, setDialogVisible] = useState(false)
  const prevIsOpenRef = useRef(false)

  useEffect(() => {
    const wasOpen = prevIsOpenRef.current
    prevIsOpenRef.current = isOpen

    if (isOpen) {
      // Use setTimeout(..., 0) to avoid synchronous setState inside the effect
      // body (satisfies react-hooks/set-state-in-effect).
      const id = setTimeout(() => setDialogVisible(true), 0)
      return () => clearTimeout(id)
    } else if (wasOpen) {
      // Transition: open → closed — let the fade play before unmounting.
      const id = setTimeout(() => setDialogVisible(false), 80)
      return () => clearTimeout(id)
    }
  }, [isOpen])

  const isAnimatingClose = dialogVisible && !isOpen
  const currentPhase = state.phase
  const currentQuery = state.phase === 'open' ? state.query : ''
  const currentArgMode = state.phase === 'open' ? state.argMode : null
  const currentPendingConfirm = state.phase === 'open' ? state.pendingConfirm : null
  const activeScopeId = isOpen
    ? (state.scopeStack[state.scopeStack.length - 1]?.scopeId ?? 'root')
    : 'root'

  const workspace = workspaceFromPathname(pathname)

  // Stable ref so runCommand doesn't stale-close over the navigate function.
  const navigateRef = useRef(navigate)
  useEffect(() => { navigateRef.current = navigate }, [navigate])
  // Same pattern for `runStepUp` — captured here once and re-read at command
  // invocation time so the CommandRunContext stays callback-stable.
  const runStepUpRef = useRef(runStepUp)
  useEffect(() => { runStepUpRef.current = runStepUp }, [runStepUp])

  // ─── ProviderRunner (Phase 3) ─────────────────────────────────────────────
  // The react-hooks/refs rule forbids reading/writing ref.current during the
  // render phase (including inside useState/useMemo factories). We therefore
  // initialise the runner inside a useEffect (commit phase), where ref access
  // is explicitly allowed. The runner is null on the very first render — the
  // "fire providers" effect below guards against that with an early return.

  // Stable commandContext ref, updated each commit so the runner always reads
  // the latest value without causing the fire-providers effect to re-run.
  const commandContextRef = useRef<CommandContext | null>(null)
  // Holds the runner instance after first mount.
  const runnerRef = useRef<ProviderRunner | null>(null)

  // dispatch from useReducer is guaranteed stable — no ref wrapper needed.
  useEffect(() => {
    const newRunner = new ProviderRunner(
      (action) => dispatch(action),
      () => commandContextRef.current,
    )
    runnerRef.current = newRunner
    return () => {
      newRunner.reset()
      runnerRef.current = null
    }
  }, []) // intentionally empty — run once on mount, clean up on unmount

  // ─── Editor context snapshot ──────────────────────────────────────────────
  // Subscribe to the editor store while the active workspace is 'site'. This
  // feeds both Spotlight filtering and direct command-shortcut dispatch.
  // The subscription is established lazily so the editor store is never loaded
  // on non-site workspaces.

  const [editorCtx, setEditorCtx] = useState<EditorCtxSnapshot | null>(null)

  useEffect(() => {
    // Not on site workspace — subscribe nothing; cleanup resets ctx.
    if (workspace !== 'site') {
      return () => { setEditorCtx(null) }
    }

    let cancelled = false
    let unsubscribe: (() => void) | null = null

    void import('@site/store/store').then(({ useEditorStore }) => {
      if (cancelled) return

      // Snapshot helper — reads the fields we care about.
      const snapshot = (): EditorCtxSnapshot => {
        const s = useEditorStore.getState()
        return {
          selectedNodeIds: s.selectedNodeIds,
          activePageId: s.activePageId,
          activeDocument: s.activeDocument as EditorCtxSnapshot['activeDocument'],
          canUndo: s.canUndo,
          canRedo: s.canRedo,
          activeBreakpointId: s.activeBreakpointId,
          activeInlineEdit: s.activeInlineEdit !== null,
        }
      }

      // Seed with current state immediately.
      setEditorCtx(snapshot())

      // Subscribe to the whole store and gate updates via a manual shallow
      // compare of the fields we care about. We intentionally do NOT pass a
      // selector function to `subscribe` — the selector path with
      // `subscribeWithSelector` middleware uses Object.is equality by default,
      // and a fresh object literal from the selector NEVER equals the
      // previous one, so the listener would fire on every store action and
      // re-snapshot constantly. Manual compare here keeps update churn low
      // and avoids the corresponding infinite-render risk in consumers.
      let last = snapshot()
      unsubscribe = useEditorStore.subscribe(() => {
        if (cancelled) return
        const next = snapshot()
        if (
          next.selectedNodeIds === last.selectedNodeIds &&
          next.activePageId === last.activePageId &&
          next.activeDocument === last.activeDocument &&
          next.canUndo === last.canUndo &&
          next.canRedo === last.canRedo &&
          next.activeBreakpointId === last.activeBreakpointId &&
          next.activeInlineEdit === last.activeInlineEdit
        ) return
        last = next
        setEditorCtx(next)
      })
    })

    return () => {
      cancelled = true
      unsubscribe?.()
      setEditorCtx(null)
    }
  }, [workspace])

  // ─── Build CommandContext ─────────────────────────────────────────────────

  const commandContext: CommandContext | null = (() => {
    if (!user) return null
    const ctx: CommandContext = {
      workspace: workspaceFromPathname(pathname),
      pathname,
      user,
    }
    if (editorCtx) ctx.editor = editorCtx
    return ctx
  })()

  // Keep commandContextRef in sync so the runner's getContext() is always fresh.
  useEffect(() => { commandContextRef.current = commandContext }, [commandContext])

  // ─── Fire async providers on open / query / scope change (Phase 3) ────────

  useEffect(() => {
    // runnerRef.current is null before the initialization effect above runs
    // (only on the very first render). Guards prevent any operation in that case.
    const runner = runnerRef.current
    if (!runner) return

    if (!isOpen) {
      // Palette closed: abort all in-flight calls and clear the cache so
      // stale results don't bleed into the next open.
      runner.reset()
      return
    }

    // Fire providers for the current scope + query. ProviderRunner handles
    // debounce, abort of the previous call, and result caching internally.
    runner.run(activeScopeId, currentQuery)
  }, [isOpen, activeScopeId, currentQuery])

  // ─── runCommandWithArgs ───────────────────────────────────────────────────
  // Core execution function: always called with the full args map.

  const runCommandWithArgs = async (
    command: Command,
    args: Record<string, string>,
  ): Promise<void> => {
    if (!commandContext) return

    recordRecentCommand(command.id)
    recordTelemetryRun(command.id)

    const runCtx: CommandRunContext = {
      ...commandContext,
      args,
      navigate: (path) => navigateRef.current(path),
      closeSpotlight: () => dispatch({ type: 'CLOSE' }),
      pushScope: (scopeId, pendingArgs) =>
        dispatch({ type: 'PUSH_SCOPE', scopeId, pendingArgs }),
      popScope: () => dispatch({ type: 'POP_SCOPE' }),
      runStepUp: <T,>(action: () => Promise<T>) => runStepUpRef.current(action),
    }

    // Run the command FIRST, then close. Commands that navigate (e.g. "Go to
    // Site editor") call `ctx.navigate(...)` directly; commands that drill
    // into a sub-scope call `ctx.pushScope(...)`. Closing before running
    // could clobber a pushScope dispatch with a CLOSE that lands later, and
    // for navigators it makes no functional difference. Commands that
    // explicitly stay open use `keepOpenAfterRun`.
    let drilledScope = false
    try {
      const result = command.run({
        ...runCtx,
        pushScope: (scopeId, pendingArgs) => {
          drilledScope = true
          dispatch({ type: 'PUSH_SCOPE', scopeId, pendingArgs })
        },
        closeSpotlight: () => {
          drilledScope = true // suppress the implicit auto-close below
          dispatch({ type: 'CLOSE' })
        },
      })
      if (result instanceof Promise) {
        await result
      }
    } catch (err) {
      console.error('[spotlight] command run failed:', err)
    }

    // Auto-close if the command didn't push a scope or close explicitly,
    // unless the command opted into staying open.
    if (!drilledScope && !command.keepOpenAfterRun) {
      dispatch({ type: 'CLOSE' })
    }
  }

  // ─── runCommand ──────────────────────────────────────────────────────────
  // Convenience wrapper: starts arg collection if command has args,
  // otherwise runs immediately with empty args.

  const runCommand = async (command: Command): Promise<void> => {
    if (command.args && command.args.length > 0) {
      dispatch({ type: 'ENTER_ARG_MODE', command })
      return
    }
    await runCommandWithArgs(command, {})
  }

  const runShortcut = (event: KeyboardEvent): boolean => {
    if (!commandContext) return false
    const shortcutCommand = findMatchingShortcutCommand(event, commandContext)
    if (!shortcutCommand) return false

    event.preventDefault()
    event.stopPropagation()
    void runCommand(shortcutCommand)
    return true
  }

  const runShortcutFromGlobalListener = useEffectEvent((event: KeyboardEvent) => runShortcut(event))

  // ─── Global Cmd+K / Ctrl+K listener ──────────────────────────────────────
  // Capture phase so the listener fires before editor keydown handlers.
  // The match predicate comes from the keybindings registry — single source of truth.

  useEffect(() => {
    const spotlightBinding = getKeybindingForCommand('spotlight.open')

    function onKeyDown(event: KeyboardEvent) {
      const isCmdK = spotlightBinding?.match(event) ?? false
      if (isCmdK) {
        event.preventDefault()
        event.stopPropagation()
        dispatch({ type: 'TOGGLE' })
        return
      }

      if (runShortcutFromGlobalListener(event)) return

      if (currentPhase !== 'open') return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (currentArgMode) {
          // Escape exits arg mode back to the command list
          dispatch({ type: 'EXIT_ARG_MODE' })
        } else if (currentPendingConfirm) {
          dispatch({ type: 'CLEAR_PENDING_CONFIRM' })
        } else if (currentQuery !== '') {
          dispatch({ type: 'SET_QUERY', query: '' })
        } else {
          dispatch({ type: 'CLOSE' })
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [currentPhase, currentQuery, currentArgMode, currentPendingConfirm])

  // ─── Destructive confirm timeout ──────────────────────────────────────────
  // Automatically clear pendingConfirm after 5 seconds.

  useEffect(() => {
    if (!currentPendingConfirm) return
    const timer = setTimeout(() => {
      dispatch({ type: 'CLEAR_PENDING_CONFIRM' })
    }, 5000)
    return () => clearTimeout(timer)
  }, [currentPendingConfirm])

  // ─── Public SpotlightControls context value ───────────────────────────────

  const controls: SpotlightControls = {
    state,
    open: () => dispatch({ type: 'OPEN' }),
    close: () => dispatch({ type: 'CLOSE' }),
    toggle: () => dispatch({ type: 'TOGGLE' }),
    runShortcut,
    pushScope: (scopeId, args) =>
      dispatch({ type: 'PUSH_SCOPE', scopeId, pendingArgs: args }),
    popScope: () => dispatch({ type: 'POP_SCOPE' }),
  }

  // ─── Internal context value for <Spotlight> ───────────────────────────────

  const internalValue: SpotlightInternalContextValue = {
    state,
    dispatch,
    commandContext,
    runCommand,
    runCommandWithArgs,
  }

  return (
    <SpotlightContext.Provider value={controls}>
      <SpotlightInternalContext.Provider value={internalValue}>
        {children}
        {dialogVisible && (
          <Suspense fallback={null}>
            <LazySpotlight isClosing={isAnimatingClose} />
          </Suspense>
        )}
      </SpotlightInternalContext.Provider>
    </SpotlightContext.Provider>
  )
}
