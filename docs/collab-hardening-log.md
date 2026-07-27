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
  path has no dedicated contention test — see open finding 1).

## Open findings (ranked)

1. **`applyTextDiff` has no drift guard** (`src/core/collab/applyPatches.ts`
   ~line 290). `applyChildrenDiff` explicitly detects "actual array ≠
   pre-mutation array" and falls back to a wholesale rewrite;
   the Y.Text path applies splice indices computed from the store's
   `preValue` blindly. If `existing.toString() !== preValue` (unreachable
   from browser input ordering as far as this run could prove, but MCP
   bridge / plugin RPC / future callers may differ), the splice corrupts
   text or throws Yjs "Length exceeded" mid-transaction. Add the analogous
   guard (diff against `existing.toString()` on drift) + a test.
2. **Y.Text instance replacement mid-session freezes the merge** — a remote
   whole-node rebuild (`yNodes.set(nodeId, buildNodeMap(...))`) swaps the
   props map and its Y.Text; `attachInlineEditRemoteMerge` observes the dead
   instance, so the surface silently degrades to frozen (and the next local
   keystroke overwrites the peer's whole-node write). Re-resolve the Y.Text
   per event (observeDeep on the node map) or force-end the session.
3. **Doc RESET mid-inline-session** — `connectCollabProvider`'s reset handler
   rebinds a fresh doc; an active inline session keeps observing the dead
   doc's Y.Text and its node may not exist in the reseed. Probably should
   force-end the inline session when the active doc resets.
4. **Properties-panel textarea under co-editing** — same whole-string commit
   path (`updateNodeProps`), but a controlled input re-rendered from the
   store: an in-flight local value can clobber a just-projected remote edit
   between renders. Unreviewed; needs the same adversarial pass the canvas
   surface got.
5. **Priority areas untouched by any run yet** (from the loop brief, in
   order): reconnect/reset overlap + stale-generation frames; crash
   durability of the persist debounce; update-guard adversarial bypass
   siblings; Postgres parity for `collab_documents` + continuous persistence;
   offline-block stress (flaky transport, toast latch); relay/awareness/
   provider leak+lifetime audit.

## Done this run

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
