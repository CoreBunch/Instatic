# Editor Tour

The Site editor's first-run guided tour: a seven-step coach-mark walkthrough built on a generic, reusable tour engine.

The tour introduces a new user to the Site editor — Explorer, module insertion, Properties panel, the Framework panel, and Publish — the first time they open `/admin/site`. It auto-starts once, persists its outcome server-side so it never reappears uninvited, and can be replayed anytime from the command palette or the dashboard onboarding checklist.

---

## TL;DR

- **Generic engine**: `src/admin/shared/tour/` — `TourStepDef`, `useTourStore` (Zustand), `TourOverlay` (SVG-spotlight coach-mark renderer). Knows nothing about the Site editor; any future tour reuses it.
- **Editor-specific tour**: `src/admin/pages/site/tour/` — `editorTourSteps.ts` (the 7 steps) + `useEditorTour.ts` (auto-start + persistence).
- Mounted once, in `AdminCanvasEditorBody` (`src/admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx`): `useEditorTour()` for auto-start, `<TourOverlay />` to render it.
- Persistence: the `editor-tour` server-side user preference (`{ status: 'completed' | 'dismissed' }`, `null` = never seen). Auto-start fires only when the preference is `null`. See [docs/reference/persistence-keys.md](../reference/persistence-keys.md).
- Replay paths: the Spotlight command **"Take the editor tour"** (`help.editorTour`, any workspace) and the Dashboard onboarding checklist's **"Tour the editor"** step — both work regardless of a persisted outcome.
- Styling: `--tour-z-index: 9500` (`src/styles/globals.css`) — above every editor surface, below toasts/tooltips. See [docs/reference/design-tokens.md](../reference/design-tokens.md).

---

## Architecture

Two layers, split by reusability:

```text
src/admin/shared/tour/          ← generic engine (editor-agnostic)
├── types.ts                        TourStepDef, TourOutcome
├── tourStore.ts                    useTourStore — Zustand: steps, stepIndex, onEnd, start/next/back/dismiss/complete
├── TourOverlay.tsx                 coach-mark renderer (SVG spotlight cutout + positioned bubble)
├── TourOverlay.module.css          backdrop, spotlight cutout, bubble chrome (--tour-z-index)
└── index.ts                        barrel: useTourStore, TourOverlay, TourOutcome, TourStepDef

src/admin/pages/site/tour/      ← Site editor's tour
├── editorTourSteps.ts              the 7-step TourStepDef[] with editor-specific prepare() callbacks
└── useEditorTour.ts                startEditorTour() + useEditorTour() auto-start hook
```

`tourStore.ts` imports nothing from `@site/*`, persistence, or spotlight/overlay modules — a future tour (e.g. a Content-workspace or Plugins-workspace walkthrough) reuses `useTourStore` and `TourOverlay` by supplying its own `TourStepDef[]` and `onEnd` callback. Everything that knows about the Site editor's own panels, anchors, and preference key lives in `src/admin/pages/site/tour/`.

### `TourStepDef`

```ts
interface TourStepDef {
  id: string                 // stable id (analytics, debugging)
  anchor: string | null      // data-testid of the target element; null = centered step
  title: string
  body: string
  side?: FloatingSide
  align?: FloatingAlign
  prepare?: () => void | Promise<void>  // put the editor into the state the anchor needs
}
```

`prepare()` runs before `TourOverlay` waits for the anchor — open the panel that contains it, dock the Properties panel and pick a selection, switch the left-sidebar tab, etc. A step whose anchor never appears (`prepare()` failed, or the element never renders) is soft-skipped: `TourOverlay` polls for up to two seconds, logs a warning, and calls `onNext()` rather than leaving the tour stuck.

### `useTourStore`

```ts
interface TourState {
  steps: TourStepDef[] | null
  stepIndex: number
  onEnd: ((outcome: TourOutcome) => void) | null
  start: (steps: TourStepDef[], onEnd: (outcome: TourOutcome) => void) => void
  next: () => void    // completes the tour on the last step
  back: () => void
  dismiss: () => void // ends with 'dismissed'
  complete: () => void // ends with 'completed'
}
```

`steps === null` is the idle state — `TourOverlay` renders nothing. Ending the tour (falling off the last step via `next()`, or explicit `dismiss()`/`complete()`) clears the running state and fires `onEnd` exactly once with the outcome.

### `TourOverlay`

Portal-rendered to `document.body`. Three-component shape:

- `TourOverlay` bails out before any hooks run when `steps === null` — no idle-render hook cost.
- `TourOverlayInner` owns subscriptions that live for the whole tour (current step index, the window-level Escape-to-dismiss listener) **and** the persistent backdrop + bubble DOM. The bubble is a single element for the entire tour run — it never remounts between steps — so its position transitions smoothly via CSS (`--tour-x`/`--tour-y`, see `TourOverlay.module.css`) instead of popping in fresh at `(0, 0)` every step. `displayed` state holds the last step that finished resolving (content + anchor element); while the *next* step is still resolving, the bubble keeps showing `displayed`'s content in place — no blank gap, no flash.
- `TourStepResolver`, remounted via `key={stepIndex}` on every step change, is a **non-visual** per-step controller: run `prepare()`, then locate the anchor (or go straight to a centered layout) via `waitForAnchor`, which polls `document.querySelector('[data-testid="<anchor>"]')` once per animation frame, and report the result upward through an `onResolved` callback (`TourOverlayInner`'s `setDisplayed` state setter, always referentially stable). Calling `onResolved`/`onNext` only ever happens *after* an `await`, so none of this trips the `react-hooks/set-state-in-effect` lint rule.

Anchored steps render an SVG mask cutting a rounded-rect "spotlight" hole around the anchor's `getBoundingClientRect()`, inflated by 6px; a `ResizeObserver` + scroll/resize listeners (owned by `TourOverlayInner`, keyed off the displayed step) keep the cutout and bubble glued to the anchor as it moves. Centered steps (`anchor: null` — welcome/finish) render a flat scrim instead, and the bubble is centered by computing a pixel `--tour-x`/`--tour-y` for the viewport center rather than a CSS `top: 50%` override — so centered steps animate through the same transform as anchored ones. The bubble itself (`role="dialog"`, `aria-modal="true"`, focused when a *new* step's content lands — not on every reposition) shows "Step N of M", title, body, and Skip/Back/Next actions; its position is computed by `computeFloatingPosition` (`@ui/lib/floatingPosition`) the same way tooltips are placed.

---

## The Site editor's tour: 7 steps

`editorTourSteps.ts` — each step's `anchor` is a `data-testid` already present on the target element:

| # | id | anchor | prepare() |
|---|----|--------|-----------|
| 1 | `welcome` | *(centered)* | — |
| 2 | `explorer` | `site-explorer-panel` | opens the Explorer's Site tab |
| 3 | `new-page` | `site-explorer-new-page` | opens the Explorer's Site tab |
| 4 | `modules` | `canvas-notch` | — |
| 5 | `properties` | `properties-panel` | docks the Properties panel; selects the active page's root node if nothing is selected (the panel only renders docked + expanded + with a selection) |
| 6 | `framework` | `framework-panel` | opens the Framework left-sidebar panel |
| 7 | `publish` | `toolbar-publish-btn` | *(centered — finish)* |

Step 5 (`properties`) is the one step whose anchor needs more than a panel-mode flip: `[data-testid="properties-panel"]` only renders when the panel is docked, not collapsed, **and** something is selected (a node, a selector class, or a selector multi-select — see `selectRightSidebarExpanded` in `@site/store/store` and the early-return in `PropertiesPanel.tsx`). A fresh session usually has no selection, so `dockPropertiesPanelWithSelection()` also selects the active page's root node when the selection is empty — `applySelection` (`selectionSlice.ts`) clears `propertiesPanel.collapsed` as a side effect, so the panel renders for free.

The `site-explorer-new-page` testid is wired through `SiteExplorerTreeSection`'s `actionTestId` prop (`src/admin/pages/site/panels/SiteExplorerPanel/SiteExplorerPanelSections.tsx`).

---

## Lifecycle — auto-start, replay, persistence

```text
useEditorTour() mounts (AdminCanvasEditorBody, every Site editor session)
  → GET /admin/api/cms/me/preferences/editor-tour
      → null (never seen) AND no tour already running → startEditorTour()
      → non-null, or fetch failed → do nothing (treated as "already seen")

startEditorTour()
  → useTourStore.getState().start(editorTourSteps, persistOutcome)

Tour ends (Skip / Finish / falls off the last step)
  → tourStore calls onEnd(outcome)
  → persistOutcome(outcome): PUT /admin/api/cms/me/preferences/editor-tour
      { status: 'completed' | 'dismissed' }
```

`startEditorTour()` (exported from `useEditorTour.ts`) is the single imperative entry point — both the auto-start effect and every replay path call it, so `persistOutcome` is always wired as the `onEnd` callback and a replay always re-persists an outcome on completion/dismissal.

A preference-fetch failure is treated as "already seen" rather than retried or blocking the editor: an install with a broken preferences endpoint should not spam every session with an unstoppable tour.

### Auto-start vs. replay race

`SitePage.tsx`'s pending-action consumer (see "Replay paths" below) and `useEditorTour`'s auto-start effect both run on mount and can race for a fresh user who replays via a queued `site.startTour` action before the preference fetch resolves. The pending-action consumer guards against double-starting: it only calls `startEditorTour()` when `useTourStore.getState().steps === null` (no tour already running), so a genuine auto-start in flight isn't reset back to step 1 with its `onEnd` dropped. The pending action still counts as "consumed" either way — a tour ending up started (by either path) satisfies it.

### Replay paths

1. **Spotlight command** `help.editorTour` ("Take the editor tour", group `help`) — `src/admin/spotlight/commands/tour.ts`, available on every workspace (`workspaces: ['any']`), gated by `site.read`.
   - On the `site` workspace: calls `startEditorTour()` directly.
   - On any other workspace: `queuePendingAction('site.startTour')` (`@admin/spotlight/pendingAction`) then navigates to `/admin/site`. `SitePage`'s pending-action consumer fires `startEditorTour()` once the editor store hydrates (`site !== null`).
2. **Dashboard onboarding checklist** — the "Tour the editor" step (`OnboardingPanel.tsx`) queues the same `site.startTour` pending action and navigates to `/admin/site`. See [docs/features/dashboard.md](dashboard.md) → "Onboarding panel".

Both replay paths work regardless of the persisted `editor-tour` outcome — only the auto-start effect checks for `null`.

---

## Adding a new tour step

1. Add a `data-testid` to the target element if it doesn't already have one.
2. Append a `TourStepDef` to `editorTourSteps` in `editorTourSteps.ts` — set `anchor` to the testid, `side`/`align` for bubble placement, and a `prepare()` if the anchor needs a panel opened or a selection made first.
3. Update the step count in any test/doc that hardcodes "7 steps" (`tests/e2e/editor-tour.e2e.ts`, this doc).

## Adding a new tour (a different feature)

1. Build a `TourStepDef[]` array — this doc's "The Site editor's tour" table is the template.
2. Write a `start<Feature>Tour()` function that calls `useTourStore.getState().start(steps, onEndCallback)`, where `onEndCallback` persists the outcome (a new user preference key — see [docs/reference/persistence-keys.md](../reference/persistence-keys.md) → "Add a server-persisted preference").
3. Mount `<TourOverlay />` once, wherever the tour's anchors live (it's already mounted for the Site editor; a Content-workspace tour would mount its own).
4. Do not import `@site/*` or Site-editor-specific modules into `src/admin/shared/tour/` — the engine stays editor-agnostic.

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Reading/writing the `editor-tour` preference directly outside `useEditorTour.ts` | Call `startEditorTour()` for replay; read `useOnboardingState()`'s `tour` fact for onboarding-checklist status |
| Adding editor-specific logic (panel names, selection rules) to `src/admin/shared/tour/` | Keep it in `editorTourSteps.ts`'s `prepare()` callbacks — the engine stays reusable |
| A tour step anchor without a `data-testid` | Add one; `TourOverlay` only matches `[data-testid="..."]` |
| Assuming a "dismissed" tour should still count as done in onboarding UI | It doesn't — `useOnboardingState` only flips `tour: 'done'` on `status === 'completed'`, deliberately, so skipping isn't mistaken for learning the editor |
| A raw z-index for tour chrome | `--tour-z-index` (`src/styles/globals.css`) — see [docs/reference/design-tokens.md](../reference/design-tokens.md) |

---

## Related

- [docs/editor.md](../editor.md) → "Guided tour" — where this fits in the Site editor
- [docs/features/spotlight.md](spotlight.md) — the `help.editorTour` command and the `help` command group
- [docs/features/dashboard.md](dashboard.md) → "Onboarding panel" — the "Tour the editor" checklist step
- [docs/reference/persistence-keys.md](../reference/persistence-keys.md) — the `editor-tour` server-side preference
- [docs/reference/design-tokens.md](../reference/design-tokens.md) → "Z-index layers" — `--tour-z-index`
- Source-of-truth files:
  - `src/admin/shared/tour/` — generic tour engine
  - `src/admin/pages/site/tour/editorTourSteps.ts` — the 7 Site editor steps
  - `src/admin/pages/site/tour/useEditorTour.ts` — auto-start + persistence
  - `src/admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx` — mount point
  - `src/admin/spotlight/commands/tour.ts` — replay command
  - `src/admin/spotlight/pendingAction.ts` — `site.startTour` cross-workspace action
  - `tests/e2e/editor-tour.e2e.ts` — TOUR-001–TOUR-003 end-to-end coverage
