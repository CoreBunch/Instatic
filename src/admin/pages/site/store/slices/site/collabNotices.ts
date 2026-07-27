/**
 * Collab block/reset policy and the user-facing copy that goes with it — kept
 * out of the binding engine so `collabBinding.ts` stays about docs, undo, and
 * projection rather than about wording and transport-state checks.
 *
 * Two situations reach the user:
 *   - BLOCK: a local edit the transport cannot deliver right now. There is no
 *     client-side save behind the relay, so an undeliverable edit is a lost
 *     edit — the editor refuses it rather than showing work already gone.
 *   - RESET: the server discarded a doc the user was editing (stale lineage,
 *     a refused write, an oversize update). Their unsent work is gone and they
 *     must be told; the routine out-of-relay reseed (`rewritten`) is silent.
 */
import { pushToast } from '@ui/components/Toast'
import type { ResetReason } from '@core/collab'
import type { CollabProvider } from '@site/collab/collabProvider'

/**
 * Why a local mutation was refused. There is no client-side persistence and no
 * save path behind the relay, so an edit that cannot be delivered is an edit
 * that is gone — the editor refuses it rather than showing work it has already
 * lost.
 */
export type BlockedReason = 'connecting' | 'offline' | 'syncing'

export type LocalPatchOutcome = { accepted: true } | { accepted: false; reason: BlockedReason }

/**
 * Can an edit made right now actually reach the relay?
 *
 * Detached mode (unit tests, and the window before the socket exists) has no
 * server to lose anything to, so it never blocks. Otherwise this is the
 * provider's own `canSend()` — one fact, shared with `sendFrame`, rather than
 * two views that can disagree.
 */
export function transportBlockReason(provider: CollabProvider | null): BlockedReason | null {
  if (!provider) return null
  if (provider.canSend()) return null
  return provider.status() === 'offline' ? 'offline' : 'connecting'
}

const BLOCK_COPY: Record<BlockedReason, string> = {
  offline: 'You are offline, so that change was not applied. It will work again as soon as the connection is back.',
  connecting: 'Still connecting to the server — that change was not applied. Try again in a moment.',
  syncing: 'This document is still loading — that change was not applied. Try again in a moment.',
}

const RESET_REASON_COPY: Record<ResetReason, string> = {
  rewritten: '',
  stale: 'This document was rebuilt while you were disconnected, so unsent changes were discarded. The latest version is now loaded.',
  refused: 'Your role does not allow that change, so it was undone.',
  oversize: 'That change was too large to sync in one step and was undone. Try making it in smaller pieces.',
}

/**
 * Latch so a burst of refused typing is ONE message per block EPISODE, not one
 * per keystroke. Cleared by {@link clearCollabBlockNotice} when the transport
 * recovers, so the next outage speaks up instead of being swallowed.
 */
let blockToastShown = false

/**
 * Toast the block message, at most once per episode. Returns `true` on the
 * FIRST toast of an episode so the binding can pair it with its own side effect
 * (snapping the in-flight contentEditable back), and `false` on the swallowed
 * repeats.
 */
export function collabBlockToast(reason: BlockedReason): boolean {
  if (blockToastShown) return false
  blockToastShown = true
  pushToast({ kind: 'error', title: 'Change not applied', body: BLOCK_COPY[reason] })
  return true
}

/** Called whenever the transport recovers, so the next block can speak again. */
export function clearCollabBlockNotice(): void {
  blockToastShown = false
}

/**
 * Toast that the server discarded a doc the user was editing. `rewritten` is
 * the routine out-of-relay reseed — another admin saved a setting, a plugin
 * installed, the data workspace edited a row. Nothing of this user's was lost,
 * so it stays silent; the other three mean their work was discarded.
 */
export function collabResetToast(reason: ResetReason): void {
  if (reason === 'rewritten') return
  pushToast({ kind: 'error', title: 'A change was reverted', body: RESET_REASON_COPY[reason] })
}
