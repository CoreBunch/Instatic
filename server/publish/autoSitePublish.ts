/**
 * Automatic full-site republish after an entry's public state changes.
 *
 * The drift this fixes
 * ────────────────────
 * A listing page (`/blog`) is a Layer A artefact like any other: its
 * `base.loop` over a content table is expanded ONCE, at full-publish time, and
 * the resulting markup is baked into the slot. Per-entry publishing
 * (`publishDataRow`) only rewrites that entry's OWN artefact — it never
 * re-expands anybody else's loop. So the moment an entry enters or leaves
 * public visibility, the listing that links to it is wrong, and stays wrong
 * until a human presses Publish:
 *
 *   • a deleted entry keeps a live card on `/blog` pointing at a 404;
 *   • a scheduled entry that fires at 09:00 is missing from `/blog` until
 *     someone notices — the scheduler flips `status` and prunes/writes the one
 *     artefact, and nothing re-bakes the index.
 *
 * A full publish is the only thing that re-expands a loop, so the fix is to run
 * one. Everything else in this module exists to make "a full publish per entry
 * change" affordable and safe.
 *
 * The four rules
 * ──────────────
 * 1. **Coalesced.** Publishing a backlog of forty posts must cost ONE site
 *    publish, not forty. The first request opens a batch window; every request
 *    that lands inside it is absorbed. Same shape as the collab relay's
 *    `schedulePersist` — arm once, ignore while armed.
 *
 * 2. **Never re-entrant.** A site publish swaps the static slot. Two overlapping
 *    runs would race that swap, so at most one run is ever in flight; requests
 *    raised during a run collapse into exactly one follow-up window (they may
 *    describe an entry the running publish read too early to see).
 *
 * 3. **Never recursive.** A site publish must not be able to trigger a site
 *    publish. That is guaranteed structurally, not by a runtime flag: the
 *    publish pipeline never calls `requestAutoSitePublish`, and
 *    `auto-site-publish-is-not-recursive.test.ts` fails the build if it starts
 *    to. A runtime origin check was considered and rejected — plugin
 *    `publish.before` / `publish.html` / `publish.after` handlers run in the
 *    QuickJS worker and their RPCs come back on their own event-loop task, so
 *    an async-context flag would report "not inside a publish" for the one
 *    caller that could actually recurse. A guard that lies is worse than none.
 *
 * 4. **Never a surprise publish.** `publishDraftSite` promotes the DRAFT site.
 *    If an operator is mid-redesign, promoting it because an author published a
 *    blog post would push unfinished work live — the exact leak the explicit,
 *    step-up-gated Publish button exists to prevent. So a run only proceeds
 *    while the draft already matches what is published: then it changes no
 *    page, and its only effect is re-expanding the loops. When the draft has
 *    unpublished edits the run is skipped and logged; that operator is about to
 *    publish anyway, which fixes the listing.
 *
 * The rebuild runs in the background: an author's publish request returns as
 * soon as their entry is committed. A failed run is logged and dropped — the
 * entry publish already committed, and `publishDraftSite` swaps the slot only
 * after a clean bake, so a failure leaves the live site exactly as it was.
 */
import type { DbClient } from '../db/client'
import { getDraftPublishStatus } from '../repositories/publish'
import { publishDraftSite } from './publishSite'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How long the batch window stays open after the first request.
 *
 * Bounded by two numbers. The floor: it has to be long enough to swallow a
 * burst — a human working down a publish queue, an agent looping over a
 * backlog, or one `tickPublishScheduler` pass firing up to `TICK_BATCH_LIMIT`
 * rows in sequence. The ceiling: the scheduler polls every 10s, so a window
 * wider than that would let a 09:00 post stay off the listing for longer than
 * it took to notice it was due.
 *
 * 5s sits between them: half a scheduler tick, and comfortably longer than the
 * gap between two consecutive per-row publishes. An author who publishes one
 * post and reloads the listing sees it.
 *
 * Note this is a fixed window from the FIRST request, not a resetting debounce.
 * A resetting debounce can be held open indefinitely by a steady trickle of
 * publishes; a fixed window bounds the delay at exactly this value.
 */
const BATCH_WINDOW_MS = 5_000

/**
 * Operator switch. Automatic republishing is ON by default — the listing being
 * wrong is a correctness bug, not a preference. Operators who publish on their
 * own cadence (a scheduled deploy, a manual pre-flight review) set this to
 * `0` / `false` / `off` / `no` and keep the old behaviour, where only an
 * explicit Publish rebuilds the site.
 *
 * Only an explicit off-token disables: an unset, empty, or unrecognised value
 * keeps the safe default rather than silently turning a correctness fix off
 * because of a typo.
 */
const ENABLED_ENV_VAR = 'AUTO_SITE_PUBLISH_ON_ENTRY_CHANGE'
const OFF_TOKENS = new Set(['0', 'false', 'off', 'no'])

export function isAutoSitePublishEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[ENABLED_ENV_VAR]
  if (raw === undefined) return true
  return !OFF_TOKENS.has(raw.trim().toLowerCase())
}

// ---------------------------------------------------------------------------
// Queue state
// ---------------------------------------------------------------------------

/**
 * What a pending run needs. Captured from the most recent request rather than
 * registered at boot: every trigger site already holds both values, so the
 * queue needs no wiring into `server/index.ts` and no module-level DB handle.
 * A single-process server only ever has one of each.
 */
interface PendingRun {
  db: DbClient
  uploadsDir: string
}

let batchTimer: ReturnType<typeof setTimeout> | null = null
let pending: PendingRun | null = null
let running = false
/** A request arrived while a run was in flight; re-arm once it finishes. */
let requestedDuringRun = false

/**
 * Ask for a full site publish because an entry entered or left public
 * visibility. Returns immediately — the rebuild happens on the batch timer.
 *
 * Call this from every path that changes whether an entry is publicly visible
 * (publish, scheduled publish, unpublish, delete), right next to the
 * `emitContentEntry*` call that path already makes. Paths that leave public
 * visibility unchanged (a draft edit, an author reassignment) must NOT call it.
 *
 * With no `uploadsDir` there is no static slot, so there are no baked listings
 * to go stale and nothing to rebuild — the request is dropped.
 */
export function requestAutoSitePublish(db: DbClient, uploadsDir: string | undefined): void {
  if (!uploadsDir) return
  if (!isAutoSitePublishEnabled()) return

  pending = { db, uploadsDir }

  // Rule 2: a run is mid-flight. Note that one more is owed and let the run's
  // own completion arm it — starting a second now would race the slot swap.
  if (running) {
    requestedDuringRun = true
    return
  }
  // Rule 1: the window is already open and this request is inside it.
  if (batchTimer !== null) return

  batchTimer = setTimeout(() => {
    batchTimer = null
    void runPendingSitePublish()
  }, BATCH_WINDOW_MS)
}

/**
 * Run the coalesced publish, then re-arm if requests arrived while it ran.
 *
 * Never throws: this is a background task with no caller to report to. A
 * failure is logged and the run is abandoned — the entry publishes that
 * requested it have already committed, and a failed bake never reaches
 * `swapSlot`, so the live site is untouched.
 */
async function runPendingSitePublish(): Promise<void> {
  const run = pending
  pending = null
  if (!run) return

  running = true
  try {
    // Rule 4: only re-bake a site that is already published as-is.
    const status = await getDraftPublishStatus(run.db)
    if (!status.hasPublishedVersion) return
    if (!status.draftMatchesPublished) {
      console.warn(
        '[publish:auto] skipped: the site draft has unpublished edits. Listings stay stale until someone publishes — which is the same action that would push those edits live.',
      )
      return
    }

    // `null` is the system actor, exactly as the scheduled-publish tick uses it
    // for per-row publishes: nobody asked for a site publish, so attributing
    // every page to whoever happened to publish a post would be a lie.
    await publishDraftSite(run.db, null, run.uploadsDir)
  } catch (err) {
    console.error('[publish:auto] site republish failed (the live site is unchanged):', err)
  } finally {
    running = false
    if (requestedDuringRun) {
      requestedDuringRun = false
      // Re-arm through the normal path so the follow-up opens its own batch
      // window instead of firing immediately behind this run. A single-process
      // server has one database and one uploads directory, so replaying this
      // run's pair is the same pair the deferred request carried.
      requestAutoSitePublish(run.db, run.uploadsDir)
    }
  }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Drop the pending batch and all queue state. For use in tests only.
 *
 * Every test that publishes a row needs this in its teardown: a batch armed by
 * one test would otherwise fire five seconds later, against a database that
 * test has already deleted.
 */
export function resetAutoSitePublishForTests(): void {
  if (batchTimer !== null) clearTimeout(batchTimer)
  batchTimer = null
  pending = null
  running = false
  requestedDuringRun = false
}

/**
 * Close the batch window now and await everything it leads to. For use in tests
 * only — it replaces the waiting, not the logic, so what runs is exactly what
 * the timer would have run.
 *
 * It DRAINS rather than running once: a follow-up armed by requests that landed
 * mid-run is followed through too. That is what makes "N changes cost one
 * publish" an assertion with teeth — a queue that failed to collapse them would
 * publish here, not five seconds after the test finished.
 *
 * The iteration cap turns a hypothetical self-re-arming loop into a failed
 * assertion on the publish count rather than a hung suite.
 */
export async function __flushAutoSitePublishForTests(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (batchTimer !== null) {
      clearTimeout(batchTimer)
      batchTimer = null
    } else if (pending === null) {
      return
    }
    await runPendingSitePublish()
  }
}
