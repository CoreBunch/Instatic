# Collab hardening log

Cross-run ledger for the autonomous review-and-harden loop on real-time
co-editing. Each run: pick the top open finding (or next priority area), break
it, prove it, fix it at source, gate it with a mutation-checked test, log it
here. Keep this file honest — it is the only memory between runs.

## Verified solid (don't re-review)

- **Y-level Y.Text merge granularity** — `src/__tests__/collab/merge.test.ts`
  pins character-level convergence for concurrent edits on pre-synced
  replicas, and `applyTextDiff`'s minimal-splice semantics when its `oldValue`
  matches the doc content. (2026-07-27)
- **Co-typing one text node end-to-end (canvas surface)** — remote Y.Text
  edits merge into the live contentEditable mid-session with caret transform;
  next local keystroke preserves both intents. Gated by
  `src/__tests__/collab/inlineEditRemoteMerge.test.tsx` (canvas mount, real
  NodeRenderer wiring) + the wiring source gate in
  `src/__tests__/canvas/inlineTextEditingWiring.test.ts`. (2026-07-27)
- **Browser event ordering protects the store-level text diff** — remote
  updates apply in WS message macrotasks and the projection flushes on a
  microtask (`scheduleProjection` → `queueMicrotask`), so the store is always
  projected before the next input-event macrotask reads it. The stale party
  was the *DOM surface*, not the store (analysis 2026-07-27; the store-level
  path is now additionally guarded against drift). (2026-07-27, hardened
  2026-07-29)
- **Patch-to-Y text drift cannot corrupt the live document** —
  `applySitePatchesToDocs` detects a projected pre-value that differs from the
  authoritative Y.Text and falls back to a safe diff from the actual value.
  Gated by `src/__tests__/collab/applyPatches.test.ts`. (2026-07-29)
- **Whole-node replacement does not freeze an inline session** —
  `attachInlineEditRemoteMerge` observes the tree deeply and re-resolves the
  current Y.Text after every non-local transaction, so replacing a node map
  and its nested text instance keeps merging. Removing the text invalidates
  the session. Gated by
  `src/__tests__/collab/inlineEditRemoteMerge.test.tsx`. (2026-07-29)
- **RESET closes an inline session only for its active document** — the store
  ends the contentEditable session before rebinding the fresh CRDT lineage;
  unrelated document resets leave it alone. Gated by
  `src/__tests__/collab/awareness.test.tsx`. (2026-07-29)
- **Properties-panel textarea follows the projected value** — it is a
  controlled React input with immediate `onChange`; a remote projection
  rewrites any not-yet-dispatched native DOM value before the next local input
  event, so the stale DOM snapshot cannot clobber the peer. Gated by
  `src/__tests__/collab/propertiesPanelTextarea.test.tsx`. (2026-07-29)
- **Reconnect and reset cannot merge a dead CRDT lineage** — reconnect catches
  up edits missed in either direction, while a stale generation receives a
  RESET instead of being applied. Gated over real WebSockets by
  `src/__tests__/server/collabRelayIntegration.test.ts`. (2026-07-29)
- **Partial-role relay writes use the same category policy as HTTP saves** —
  direct guard tests cover content/style/structure separation for page and
  site docs, roster membership, and the structure-only component/layout rule.
  Gated by `src/__tests__/server/collabUpdateGuard.test.ts` plus the real-socket
  refused-write/reset path. (2026-07-29)
- **Transient persistence failure cannot silently evict an accepted edit** —
  a dirty zero-reference doc remains resident, retries automatically, and is
  evicted only after persistence succeeds. Explicit publish/reset flushes fail
  rather than continuing with stale derived JSON. Gated by
  `src/__tests__/server/collabRelay.test.ts`. Normal shutdown, last-client
  release, and publish all flush synchronously; a hard process/host crash can
  still lose at most the default 800 ms debounce window (an explicit bounded
  recovery-point tradeoff, not an unbounded dirty state). (2026-07-29)
- **Offline/backlogged transport blocks edits visibly once per episode** —
  heartbeat timeout and buffered-byte pressure both close the write gate; the
  first refused edit toasts and snaps inline editing back, repeats stay quiet,
  and recovery re-arms the notice. Gated by
  `src/__tests__/collab/provider.test.ts` and
  `src/__tests__/collab/collabNotices.test.ts`. (2026-07-29)
- **Provider teardown is terminal** — destroy detaches socket callbacks before
  close, clears timers/listeners, and removes every Y.Doc update handler; a
  socket that finishes opening late cannot resurrect the heartbeat. Gated by
  `src/__tests__/collab/provider.test.ts`. (2026-07-29)
- **PostgreSQL collaboration persistence parity** — on a disposable Postgres
  16 database, the migrations applied from scratch, relay persistence wrote
  both `collab_documents` state and derived row JSON, and two real WebSocket
  clients edited concurrently, converged, and persisted. The same focused
  tests also pass on SQLite. (2026-07-29)

## Open findings (ranked)

None from the release-hardening brief. The bounded hard-crash recovery point
(at most the default 800 ms persistence debounce) is documented above.

## Done this run

### 2026-07-29 — release integration and text-surface hardening

- Merged current `origin/main`; the only conflicts were the newer removal of
  the publish success callout. The resolution keeps collab sync gating and
  adopts the newer global error-toast behavior.
- Guarded patch-to-Y text translation against a stale projected pre-value.
- Reworked inline remote merge to follow replacement Y.Text instances and
  invalidate when the edited text disappears.
- Closed active inline editing before a reset rebinds that document.
- Proved the controlled Properties-panel textarea adopts remote projection
  before the next local input event.
- Hardened failed persistence: automatic retry, no dirty-doc eviction, and
  explicit flush failure instead of stale publish/reset continuation.
- Added adversarial per-document capability-guard coverage.
- Verified real-socket reconnect, offline-authored edit recovery, reset overlap,
  stale-generation refusal, and publish flush behavior.
- Verified migrations, continuous persistence, and two-client convergence on
  a disposable PostgreSQL 16 instance as well as SQLite.
- Closed provider late-open/listener teardown and pinned the offline notice
  latch across outage/recovery episodes.
- Production build and lint pass; the full suite passes 6,419/6,419 tests,
  including the real-WebSocket collaboration integration and architecture
  gates.

### 2026-07-27 — co-typing one text node deleted the peer's characters

- **Defect** (priority area 1, the headline promise): the inline-edit
  contentEditable was seeded once per session and never received remote
  Y.Text changes; every keystroke committed the element's whole string via
  the snapshot diff. With a peer's characters in the doc but not in the
  frozen surface, the next local keystroke's diff read them as a local
  deletion and removed them from the CRDT.
- **Proof**: canvas-mount repro (real NodeRenderer, iframe portal, real
  store + detached collab docs, remote replica at the Y level): peer typed
  `" world"` into `"hello"`; store projected `"hello world"`; surface stayed
  `"hello"`; one local keystroke `"!"` converged BOTH replicas to
  `"hello!"` — the peer's edit silently destroyed everywhere.
- **Fix at source**: `src/admin/pages/site/collab/inlineEditRemoteMerge.ts` —
  observe the edited prop's Y.Text for the session's lifetime; fold every
  non-local change into the DOM via the same seeding writer; restore the
  local caret at an index transformed through the Yjs delta (insert-at-caret
  pushes right, matching relative-position association); defer rewrites
  during IME composition to `compositionend` (caret then transformed through
  a synthesized single-splice delta). Wired in `NodeRenderer`'s session
  layout effect. Dedup: `nodeTextOf` moved to `@core/collab` schema (was a
  private helper in `caretPositions.ts`).
- **Mutation check**: reverted the NodeRenderer wiring → both canvas
  behavioral tests fail (frozen surface, `"hello"` ≠ `"hello world"`) and
  the wiring source gate fails; restored → all green.
- **Tests**: `src/__tests__/collab/inlineEditRemoteMerge.test.tsx` (2 canvas
  end-to-end incl. convergence back to the peer replica, 3 pure caret
  transform, 4 surface-level: `<br>` caret preservation, LOCAL_ORIGIN
  no-rewrite, composition deferral, detach).
