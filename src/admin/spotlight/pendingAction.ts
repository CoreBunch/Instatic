/**
 * pendingAction — sessionStorage-backed channel for cross-workspace actions.
 *
 * Many "Create new X" commands need to run on a specific workspace page (the
 * dialog or store mutation lives there). When the spotlight is invoked from
 * a different workspace, the command:
 *   1. Queues a pending action with `queuePendingAction(...)`.
 *   2. Navigates to the target workspace.
 *
 * The target page reads `consumePendingAction(type)` once on mount and
 * executes the action (opens a dialog, calls a store mutation, etc.). The
 * read is destructive — a consumed action does not fire again on refresh.
 *
 * Why sessionStorage (not a global Zustand atom)?
 *   - Survives the React tree teardown that happens when navigating from
 *     /admin/account → /admin/site (the entire admin shell re-renders).
 *   - Doesn't bloat the editor store with non-editor state.
 *   - Tab-scoped: opening a new tab starts with an empty queue.
 *
 * Schema: validated via TypeBox at the boundary. Invalid stored data is
 * silently discarded — pending actions are best-effort UX, never a hard
 * dependency.
 */

import { Type, type Static } from '@sinclair/typebox'
import { safeParseJson } from '@core/utils/jsonValidate'

// ─── Action types ────────────────────────────────────────────────────────────

/**
 * Every cross-workspace action the spotlight can queue. Adding a new one:
 *   1. Add it to the union below.
 *   2. Add a `case` arm in the receiving page's `useEffect` consumer.
 */
const PENDING_ACTION_TYPES = [
  'site.newPage',
  'site.newVisualComponent',
  'content.newCollection',
  'content.newDocument',
  'data.newTable',
  'users.invite',
  'users.newRole',
  'media.upload',
  'media.newFolder',
  'plugins.install',
] as const

type PendingActionType = (typeof PENDING_ACTION_TYPES)[number]

// ─── Schema ──────────────────────────────────────────────────────────────────

const PendingActionSchema = Type.Object({
  type: Type.Union(PENDING_ACTION_TYPES.map((t) => Type.Literal(t))),
  args: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Wall-clock ms when the action was queued. Used to expire stale entries. */
  queuedAt: Type.Number(),
})

type PendingAction = Static<typeof PendingActionSchema>

// ─── Storage ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'instatic-spotlight-pending-action'

/**
 * Actions older than this are ignored on consume. Prevents an action queued
 * before a hard refresh from firing minutes later when the user navigates to
 * the workspace for an unrelated reason.
 */
const STALE_AFTER_MS = 30_000

/**
 * Queue an action to run on the target workspace's next mount. Idempotent:
 * a second queue call within one navigation overwrites the first.
 */
export function queuePendingAction(
  type: PendingActionType,
  args?: Record<string, string>,
): void {
  try {
    const action: PendingAction = { type, args, queuedAt: Date.now() }
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(action))
  } catch {
    // sessionStorage may be unavailable (private mode, quota, etc.). Pending
    // actions are best-effort UX; failing the write is benign — the user
    // still landed on the right workspace, they just need to click the
    // on-page "New" button themselves.
  }
}

/**
 * Read the queued action WITHOUT clearing it. Returns null when no matching
 * action is pending or it's stale (stale entries are cleared). Use when a
 * parent component (e.g. UsersPage) needs to inspect the action to switch
 * tabs before the receiving tab's useEffect consumer fires.
 */
export function peekPendingAction(
  type: PendingActionType,
): PendingAction | null {
  const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? null
  if (!raw) return null

  const result = safeParseJson(raw, PendingActionSchema)
  if (!result.ok) {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY)
    return null
  }
  const parsed = result.value
  if (parsed.type !== type) return null
  if (Date.now() - parsed.queuedAt > STALE_AFTER_MS) {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY)
    return null
  }
  return parsed
}

/**
 * Read AND CLEAR the queued action if it matches `type` and is not stale.
 * Returns `null` when no matching action is pending.
 */
export function consumePendingAction(
  type: PendingActionType,
): PendingAction | null {
  const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? null
  if (!raw) return null

  const result = safeParseJson(raw, PendingActionSchema)
  if (!result.ok) {
    // Corrupt entry — clear it so a future call doesn't keep re-parsing it.
    globalThis.sessionStorage?.removeItem(STORAGE_KEY)
    return null
  }

  const parsed = result.value
  if (parsed.type !== type) return null

  if (Date.now() - parsed.queuedAt > STALE_AFTER_MS) {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY)
    return null
  }

  globalThis.sessionStorage?.removeItem(STORAGE_KEY)
  return parsed
}
