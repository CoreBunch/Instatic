/**
 * Toast bus — singleton event source decoupled from React.
 *
 * Producers (error boundaries, async handlers, plugin runtime) call
 * `pushToast({ kind, title, body })`. The single mounted `<ToastProvider />`
 * subscribes via `subscribeToasts` and renders the resulting list.
 *
 * Why a module-level bus rather than React context:
 *   - Error boundaries must be able to push from `componentDidCatch`, which
 *     runs outside the normal render flow and can't safely call `useContext`.
 *   - Plugin runtime / non-React code (server callbacks, store middleware)
 *     can publish notifications without taking a React dependency.
 *
 * Constraints:
 *   - Pure module — no JSX here.
 *   - Each toast has a stable id; producers receive it back so they can
 *     dismiss imperatively (e.g. when the boundary resets).
 *   - The provider is the single source of truth for visibility and timing —
 *     this module only stores the canonical list.
 */

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

interface ToastInput {
  /** Visual + a11y kind. Errors and warnings render with role="alert". */
  kind: ToastKind
  /** Short headline (one line). */
  title: string
  /** Optional detail body — wraps to ~3 lines before truncation. */
  body?: string
  /**
   * Free-form location tag (e.g. "error-boundary:canvas") — surfaced in dev
   * builds and copy-to-clipboard payloads so a screenshot tells you where the
   * failure came from without diving into devtools.
   */
  location?: string
  /**
   * Auto-dismiss after this many ms. Errors default to 8000, others to 4000.
   * Pass `null` to keep the toast until the user closes it.
   */
  durationMs?: number | null
  /**
   * Optional secondary action (e.g. "Copy stack"). Rendered as a Button next
   * to the close affordance.
   */
  action?: ToastAction
}

interface ToastAction {
  label: string
  /**
   * Called when the action is clicked. If it returns a promise, the toast
   * stays mounted until the promise resolves.
   */
  onSelect: () => void | Promise<void>
}

export interface Toast extends ToastInput {
  /** Stable identifier; producers can dismiss with this. */
  id: string
  /** ms-since-epoch the toast was published — used for stable ordering. */
  createdAt: number
}

type Listener = (toasts: ReadonlyArray<Toast>) => void

let counter = 0
const toasts: Toast[] = []
const listeners = new Set<Listener>()

function nextId(): string {
  counter += 1
  return `toast-${counter}-${Date.now().toString(36)}`
}

function notify(): void {
  const snapshot = toasts.slice()
  for (const listener of listeners) listener(snapshot)
}

/**
 * Push a new toast onto the queue. Returns the assigned id so the caller can
 * dismiss it imperatively if needed.
 */
export function pushToast(input: ToastInput): string {
  const id = nextId()
  toasts.push({ ...input, id, createdAt: Date.now() })
  notify()
  return id
}

/** Remove a toast by id. No-op if the id is not present. */
export function dismissToast(id: string): void {
  const idx = toasts.findIndex((t) => t.id === id)
  if (idx === -1) return
  toasts.splice(idx, 1)
  notify()
}

/**
 * Subscribe to bus updates. The listener is invoked synchronously with the
 * current snapshot on each push/dismiss. Returns an unsubscribe fn.
 */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  listener(toasts.slice())
  return () => {
    listeners.delete(listener)
  }
}

export function __resetToastBusForTests(): void {
  counter = 0
  toasts.splice(0)
  listeners.clear()
}
