/**
 * ErrorBoundary — shared boundary primitive for the CMS admin tree.
 *
 * Why this exists
 * ───────────────
 * React's "Add an error boundary to your tree" suggestion is the only way to
 * keep a render-time crash from blanking the whole page. This primitive plugs
 * boundaries into the architectural seams of the CMS (admin shell, canvas,
 * plugin page renderer, per-node module renderer) and wires them into the
 * project's existing logging + toast conventions:
 *
 *   1. `console.error('[error-boundary:<location>]', ...)` — matches the
 *      `[<module>]` prefix rule from CLAUDE.md
 *   2. Walks `error.cause` chains so typed domain errors render their full
 *      provenance (SiteValidationError, VisualComponentNameError, etc.)
 *   3. Pushes a toast via the shared toast bus so devs see boundary catches
 *      even when devtools is closed
 *   4. Resets state when `resetKeys` change (route, page id, module id) so
 *      navigation naturally clears stuck error states
 *   5. Dev fallback shows location, error chain, component stack, and Reset.
 *      Prod fallback shows a minimal apology + Reset.
 *
 * Usage
 * ─────
 *   <ErrorBoundary location="canvas" resetKeys={[activePageId]}>
 *     <CanvasRoot />
 *   </ErrorBoundary>
 *
 * The `location` string ends up in:
 *   - the console prefix
 *   - the toast `data-toast-location` attribute and rendered location chip
 *   - the architecture coverage gate (each seam asserts a unique location)
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { pushToast } from '@ui/components/Toast'
import {
  flattenErrorChain,
  formatErrorReport,
  logErrorChain,
  type ErrorChainEntry,
} from './errorReporting'
import styles from './ErrorBoundary.module.css'

interface ErrorBoundaryFallbackInfo {
  location: string
  chain: ErrorChainEntry[]
  componentStack: string | null
  reset: () => void
}

interface ErrorBoundaryProps {
  /**
   * Architectural label for this boundary. Surfaced in console logs, toasts,
   * and the dev fallback. Must be unique across the boundary placements
   * enforced by `error-boundary-coverage.test.ts`.
   *
   * Examples: "admin-shell", "admin-route", "canvas", "plugin-page",
   * "node-renderer", "module-sandbox".
   */
  location: string
  /**
   * Bump any of these to clear the boundary's error state. Use a stable
   * identifier that meaningfully changes when the user navigates to a fresh
   * context (route pathname, active page id, plugin id).
   */
  resetKeys?: ReadonlyArray<unknown>
  /** Custom fallback. Receives the error context + a reset callback. */
  fallback?: (info: ErrorBoundaryFallbackInfo) => ReactNode
  /**
   * If true, swallow the toast push for this boundary. Default false. Used
   * for module-level boundaries that catch *expected* failures (e.g. plugin
   * runtime probe) where surfacing one toast per node would spam the stack.
   */
  silentToast?: boolean
  children: ReactNode
}

interface ErrorBoundaryState {
  chain: ErrorChainEntry[] | null
  componentStack: string | null
  /** Snapshot of `resetKeys` that was active when the boundary entered the
   *  errored state — compared in `getDerivedStateFromProps` to detect resets. */
  resetSnapshot: ReadonlyArray<unknown>
}

function shallowEqualKeys(
  a: ReadonlyArray<unknown>,
  b: ReadonlyArray<unknown>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false
  }
  return true
}

const EMPTY_KEYS: ReadonlyArray<unknown> = []

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    chain: null,
    componentStack: null,
    resetSnapshot: this.props.resetKeys ?? EMPTY_KEYS,
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { chain: flattenErrorChain(error) }
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    const next = props.resetKeys ?? EMPTY_KEYS
    if (state.chain && !shallowEqualKeys(state.resetSnapshot, next)) {
      return { chain: null, componentStack: null, resetSnapshot: next }
    }
    if (!state.chain && state.resetSnapshot !== next) {
      return { resetSnapshot: next }
    }
    return null
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const chain = flattenErrorChain(error)
    const componentStack = info.componentStack ?? null
    const prefix = `error-boundary:${this.props.location}`

    logErrorChain(prefix, chain, componentStack)

    this.setState({ componentStack })

    if (!this.props.silentToast) {
      const head = chain[0]
      pushToast({
        kind: 'error',
        title: `Render failed in ${this.props.location}`,
        body: `${head.name}: ${head.message}`,
        location: prefix,
        action: {
          label: 'Copy details',
          onSelect: () => {
            const text = formatErrorReport(this.props.location, chain, componentStack)
            void copyToClipboard(text)
          },
        },
      })
    }
  }

  reset = (): void => {
    this.setState({ chain: null, componentStack: null })
  }

  render(): ReactNode {
    if (!this.state.chain) return this.props.children

    const fallbackInfo: ErrorBoundaryFallbackInfo = {
      location: this.props.location,
      chain: this.state.chain,
      componentStack: this.state.componentStack,
      reset: this.reset,
    }

    if (this.props.fallback) return this.props.fallback(fallbackInfo)
    return <DefaultErrorFallback {...fallbackInfo} />
  }
}

// ─── Default fallback UI ─────────────────────────────────────────────────────

function DefaultErrorFallback({
  location,
  chain,
  componentStack,
  reset,
}: ErrorBoundaryFallbackInfo) {
  const isDev = import.meta.env?.DEV ?? false
  const head = chain[0]

  async function handleCopy() {
    await copyToClipboard(formatErrorReport(location, chain, componentStack))
  }

  return (
    <section
      role="alert"
      aria-labelledby={`error-boundary-${location}-title`}
      className={styles.fallback}
      data-error-location={location}
    >
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <CircleAlertSolidIcon size={16} />
        </span>
        <div className={styles.headText}>
          <h2 id={`error-boundary-${location}-title`} className={styles.title}>
            {isDev ? `Render failed in ${location}` : 'This part of the page failed to load.'}
          </h2>
          {isDev ? (
            <p className={styles.message}>
              <code>{head.name}</code>: {head.message}
            </p>
          ) : (
            <p className={styles.message}>
              We&apos;ve logged the error. You can try again, or refresh the page.
            </p>
          )}
        </div>
      </div>

      {isDev && chain.length > 1 && (
        <ol className={styles.causeChain}>
          {chain.slice(1).map((entry, i) => (
            <li key={i}>
              <code>{entry.name}</code>: {entry.message}
            </li>
          ))}
        </ol>
      )}

      {isDev && componentStack && (
        <details className={styles.details}>
          <summary>Component stack</summary>
          <pre className={styles.stack}>{componentStack.trim()}</pre>
        </details>
      )}

      <div className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={reset}>
          <ReloadIcon size={13} aria-hidden="true" />
          <span>Reset</span>
        </Button>
        {isDev && (
          <Button variant="ghost" size="sm" onClick={() => void handleCopy()}>
            <CopySolidIcon size={13} aria-hidden="true" />
            <span>Copy details</span>
          </Button>
        )}
      </div>
    </section>
  )
}

// ─── Clipboard helper ────────────────────────────────────────────────────────

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch (err) {
    console.error('[error-boundary] clipboard write failed:', err)
  }
}
