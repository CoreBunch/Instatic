/**
 * ToastProvider — mounts once at the admin shell and renders bus-published
 * toasts in a fixed-position stack at the bottom-right of the viewport.
 *
 * Render path:
 *   1. Subscribes to `subscribeToasts`; React state mirrors the bus snapshot.
 *   2. Each toast renders with role="alert" (errors / warnings) or "status"
 *      (info / success).
 *   3. Toasts auto-dismiss based on their `durationMs` (8s for errors, 4s for
 *      others, or `null` to keep until manually closed).
 *
 * Pause-on-hover: the auto-dismiss timer pauses while the user hovers the
 * stack, so multi-toast bursts stay readable. Resumes on mouseleave.
 *
 * Constraints:
 *   - CSS Modules only, achromatic + semantic state tokens
 *   - No Tailwind, no inline styles except dynamic CSS custom properties
 *   - role="alert" / role="status" per toast kind
 *   - Close affordance + optional action use the Button primitive
 *   - Pixel-art icons only (close, circle-alert, warning-diamond)
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { ensurePortalRoot } from '@ui/lib/portalRoot'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import {
  dismissToast,
  subscribeToasts,
  type Toast,
  type ToastKind,
} from './toastBus'
import styles from './Toast.module.css'

const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  error: 8000,
  warning: 6000,
  success: 4000,
  info: 4000,
}

const TOAST_ROOT_ID = 'toast-root'

/**
 * Resolve the role attribute from the kind. Errors / warnings interrupt
 * assistive tech; info / success are non-blocking status announcements.
 */
function ariaRoleForKind(kind: ToastKind): 'alert' | 'status' {
  return kind === 'error' || kind === 'warning' ? 'alert' : 'status'
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'error') return <CircleAlertSolidIcon size={14} aria-hidden="true" />
  if (kind === 'warning') return <WarningDiamondSolidIcon size={14} aria-hidden="true" />
  // success / info share the circle-alert glyph at lower visual weight
  return <CircleAlertSolidIcon size={14} aria-hidden="true" />
}

export function ToastProvider() {
  const [items, setItems] = useState<ReadonlyArray<Toast>>([])
  const [paused, setPaused] = useState(false)
  const portalRoot = typeof document !== 'undefined' ? ensurePortalRoot(TOAST_ROOT_ID) : null

  useEffect(() => {
    return subscribeToasts((next) => setItems(next))
  }, [])

  // Single timer-lifecycle effect: arm a setTimeout per visible toast (unless
  // paused or opted-out), and clean them up on re-render / unmount.
  //
  // Cleanup clears every timer this effect created, so when `items` or
  // `paused` flips we drop the previous set entirely and the next setup phase
  // re-arms a fresh batch. That means a toast's countdown restarts whenever
  // the items list changes (e.g. a new toast arrives) — acceptable trade-off
  // because durations are short (4–8s) and the alternative was carrying timer
  // state across renders via a ref, which leaves setTimeout without a
  // matching cleanup in the same effect.
  useEffect(() => {
    if (paused) return
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    for (const toast of items) {
      if (toast.durationMs === null) continue
      const duration = toast.durationMs ?? DEFAULT_DURATION_MS[toast.kind]
      const timer = setTimeout(() => {
        timers.delete(toast.id)
        dismissToast(toast.id)
      }, duration)
      timers.set(toast.id, timer)
    }
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [items, paused])

  if (!portalRoot || items.length === 0) return null

  return createPortal(
    <div
      className={styles.stack}
      data-testid="toast-stack"
      aria-label="Notifications"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {items.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>,
    portalRoot,
  )
}

async function runToastAction(
  action: NonNullable<Toast['action']>,
  setActionPending: (v: boolean) => void,
): Promise<void> {
  setActionPending(true)
  try {
    await Promise.resolve(action.onSelect())
  } catch (err) {
    console.error(`[toast] action "${action.label}" failed:`, err)
  } finally {
    setActionPending(false)
  }
}

function ToastItem({ toast }: { toast: Toast }) {
  const [actionPending, setActionPending] = useState(false)

  async function handleAction() {
    if (!toast.action) return
    await runToastAction(toast.action, setActionPending)
  }

  return (
    <div
      role={ariaRoleForKind(toast.kind)}
      aria-live={toast.kind === 'error' || toast.kind === 'warning' ? 'assertive' : 'polite'}
      className={cn(styles.toast, styles[`kind-${toast.kind}`])}
      data-toast-kind={toast.kind}
      data-toast-location={toast.location}
    >
      <span className={styles.icon} aria-hidden="true">
        <ToastIcon kind={toast.kind} />
      </span>
      <div className={styles.content}>
        <p className={styles.title}>{toast.title}</p>
        {toast.body && <p className={styles.body}>{toast.body}</p>}
        {toast.location && (
          <p className={styles.location}>{toast.location}</p>
        )}
      </div>
      <div className={styles.actions}>
        {toast.action && (
          <Button
            variant="secondary"
            size="micro"
            onClick={() => void handleAction()}
            disabled={actionPending}
          >
            <span>{toast.action.label}</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label="Dismiss notification"
          onClick={() => dismissToast(toast.id)}
        >
          <CloseIcon size={12} aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
