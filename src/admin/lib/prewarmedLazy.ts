/**
 * `prewarmedLazy` — React.lazy alternative with two properties React.lazy
 * lacks: an explicit `.preload()` trigger and a synchronous-render fast
 * path once the module is loaded.
 *
 * Why this exists
 * ---------------
 * A `React.lazy` loader that chains off a dynamic page import has a subtle
 * bug for our use case: the loader returns a NEW `.then()` chain every time React
 * calls it. Even when the underlying module is fully cached by the
 * browser AND populated in V8's module map, `.then` is a microtask —
 * React's reconciler sees a pending promise and renders the Suspense
 * fallback for ONE tick before the chain resolves. For workspace
 * navigation (Dashboard ↔ Site ↔ Content ↔ ...), that one-tick
 * fallback flashes as a "loading screen flicker" on every nav click.
 *
 * What this does instead
 * ----------------------
 * - Exposes an explicit `.preload()` method on the wrapped component.
 *   Calling `MyPage.preload()` fires the dynamic import immediately
 *   and caches the resolved component. Subsequent calls are no-ops.
 *
 * - The loader is NOT auto-fired at construction time. The active page
 *   loads when React renders it (the render path calls `preload()`
 *   itself via Suspense). The OTHER pages stay dormant until something
 *   explicitly calls `MyOtherPage.preload()`.
 *
 *   This is what unlocks the prioritization the previous design was
 *   missing: the page the user is actually viewing loads alone (no
 *   8 sibling compilations stealing dev-server CPU), then the host
 *   triggers background preloads for the rest AFTER the active page
 *   has painted.
 *
 * - First render before the load resolves: throws the pending promise
 *   so the nearest `<Suspense>` boundary shows its fallback. Same UX
 *   as React.lazy on the cold path.
 *
 * - Subsequent renders: returns the cached component DIRECTLY via
 *   `createElement(Cached, props)`. No microtask, no Suspense, no
 *   fallback flash. The navigation feels instant.
 *
 * Cost model
 * ----------
 * AuthenticatedAdmin's chunk is unchanged — wrapped pages stay as
 * separate chunks (the loader uses `import()` which Vite/Rolldown
 * keeps lazy-bundled). What's eager is the host scheduling: the
 * active page when it mounts, the others scheduled when the host
 * decides (idle callback after first paint, typically).
 *
 * The pattern is a direct port of `react-loadable` / `loadable-
 * components`' "preload + synchronous render" strategy, adapted for
 * React 19. The official future-direction in React 19 is the `use()`
 * hook, but it still triggers Suspense on first read; the synchronous
 * fast-path here is what eliminates the second-and-onwards flash.
 */
import { createElement, type ComponentType, type ReactElement } from 'react'

// We accept any loader that returns a thenable containing a component
// (or `{ default: Component }`). The component's prop signature is
// erased into `unknown` for the loader's contract, but recovered at
// the wrapper-component level via the `TProps` type parameter on
// `prewarmedLazy`. This avoids the variance pitfall where TS would
// otherwise reject `Component<never>` as not assignable to
// `Component<Record<string, unknown>>`.
type LoadedModule = ComponentType<never> | { default: ComponentType<never> }
type ModuleLoader = () => Promise<LoadedModule>

interface PrewarmedLazyOptions {
  /** Optional display name for React DevTools. */
  displayName?: string
}

/** The wrapped component, with a `preload` method attached. */
type PrewarmedComponent<TProps> = ComponentType<TProps> & {
  /**
   * Fire the dynamic import (idempotent). Subsequent calls return the
   * same promise. Returns a promise that resolves when the underlying
   * module is ready — callers usually don't need to await; the trigger
   * itself is the side effect.
   */
  preload: () => Promise<unknown>
}

/**
 * Wrap a dynamic-import loader in a component that:
 *   1. Stays dormant until either:
 *      a) React renders it (cold path — triggers preload, throws to
 *         Suspense until the import lands), OR
 *      b) Something explicitly calls `.preload()` on the wrapped
 *         component (background path — fires the import in the
 *         background while the user sees something else).
 *   2. Renders synchronously once the module is loaded.
 *
 * Returns a `ComponentType<TProps> & { preload }` — a regular React
 * component with one extra method. No `Suspense` boundary required by
 * the helper itself, though one is required upstream to catch the
 * cold-path throw.
 */
export function prewarmedLazy<TProps extends Record<string, unknown> = Record<string, unknown>>(
  loader: ModuleLoader,
  options: PrewarmedLazyOptions = {},
): PrewarmedComponent<TProps> {
  let cached: ComponentType<TProps> | null = null
  let pending: Promise<unknown> | null = null
  let failure: unknown = null

  function preload(): Promise<unknown> {
    if (pending !== null) return pending
    pending = (loader() as Promise<unknown>)
      .then((mod) => {
        // Accept either `{ default: Component }` or a bare component.
        const exported = (mod as { default?: ComponentType<TProps> }).default
        cached = (exported ?? (mod as unknown as ComponentType<TProps>))
      })
      .catch((err: unknown) => {
        failure = err
        // Re-throw so any other callers of preload() see the rejection.
        throw err
      })
    return pending
  }

  function PrewarmedLazy(props: TProps): ReactElement {
    if (cached !== null) {
      // Fast path — module is loaded. Render synchronously.
      // This is the line that eliminates the React.lazy fallback flash.
      return createElement(cached, props)
    }
    if (failure !== null) {
      // Reject path — surface the error to the nearest error boundary.
      // Throw a normal error (not the promise) so error boundaries
      // catch it instead of Suspense.
      throw failure
    }
    // Cold path — module hasn't started loading yet (or hasn't resolved).
    // Fire/return the preload promise. Throwing it signals the nearest
    // `<Suspense>` to render its fallback until the import lands.
    throw preload()
  }
  PrewarmedLazy.displayName = options.displayName ?? 'PrewarmedLazy'

  // Attach `.preload()` so the host (AuthenticatedAdmin) can schedule
  // background preloads for non-active pages after the active page has
  // painted. Idempotent — multiple calls return the same promise.
  return Object.assign(PrewarmedLazy, { preload }) as PrewarmedComponent<TProps>
}
