# Dashboard

The Dashboard workspace at `/admin/dashboard` — the admin home. A configurable 12-column tile grid of widgets, a personalized greeting, the onboarding panel, and a block library for adding widgets in customize mode.

The Dashboard is the **canonical implementation** of the borderless-tile-card pattern: borderless cards on a darker parent surface with a 1px grid gap (`--gap: 1px` → `16px` during customize mode), 16px radius, surface-tone hover. See [docs/design.md](../design.md) for the design principle.

---

## TL;DR

- Page entrypoint: `src/admin/pages/dashboard/DashboardPage.tsx`.
- Grid: `DashboardGrid` — 12 columns × 70px row track. `auto-flow: dense` lets widgets backfill earlier gaps.
- Widget registry: `dashboardWidgetRegistry` singleton in `src/core/dashboard/registry.ts`. First-party widgets register on mount; plugins with `dashboard.widgets.register` contribute more.
- Widgets are draggable (move) and resizable (column / row span). Drop targets and resize previews use `--accent-3` for the dashed indicator.
- Customize mode: dashed outline + bottom-docked `<BlockLibrary>` of unused widgets. Toggled by a top-toolbar button.
- Layout persists per-user via `useDashboardLayout` (server-side `user_preferences`).
- Stats stream from `/admin/api/cms/dashboard/<domain>` (`handleDashboardRoutes` → `server/repositories/audit.ts`, `media.ts`, `data/...`, plus a `fs.stat` walk for plugins and a dialect-aware DB size query for storage).

---

## Where the code lives

```text
src/admin/pages/dashboard/
├── DashboardPage.tsx            — page entrypoint, DndContext, header + grid + library
├── DashboardPage.module.css
├── widgetIcons.ts               — icon lookup helper for widget identity
├── components/
│   ├── DashboardGrid.tsx        — 12-column grid, resize handles, drop preview
│   ├── DashboardGrid.module.css — the 1px-gap pattern + customize-mode transitions
│   ├── BlockLibrary.tsx         — bottom-docked dock of unused widgets in customize mode
│   ├── BlockLibrary.module.css
│   ├── OnboardingPanel.tsx      — first-run setup checklist (completion ring:
│   │                              the shared @ui LiquidProgressRing primitive)
│   └── OnboardingPanel.module.css
├── hooks/
│   ├── useDashboardLayout.ts    — layout state (positions / sizes) + DnD + resize math
│   ├── useDashboardStats.ts     — fetches /admin/api/cms/dashboard
│   ├── useDashboardWidgets.ts   — joins registry + persisted layout into a render list
│   └── useOnboardingState.ts    — onboarding checklist state
└── widgets/                     — first-party widgets (each is a DashboardWidgetDefinition)
    ├── ActivityWidget.tsx
    ├── DomainWidget.tsx
    ├── MediaWidget.tsx
    ├── PagesWidget.tsx
    ├── PluginsWidget.tsx
    ├── PostsWidget.tsx
    ├── PublishQueueWidget.tsx
    ├── StatusWidget.tsx
    ├── StorageWidget.tsx
    ├── widgets.module.css       — widget-shared CSS
    └── index.ts                 — registerFirstPartyDashboardWidgets()

src/core/dashboard/
├── types.ts                     — DashboardWidgetDefinition, DashboardWidgetSize, ...
├── registry.ts                  — DashboardWidgetRegistry singleton
└── iconLookup.ts                — icon helper used by widgets
```

---

## Grid layout

`DashboardGrid` is a 12-column CSS grid with a fixed row height. Each widget cell:

- `--col`, `--row` — explicit grid placement (persisted)
- `--span: <N>` — column span (3, 4, 6, 8, 12)
- `--rows: <N>` — row span (height in row tracks)

```css
.gridLayout {
  --row-h: 70px;
  --gap:   1px;                         /* 16px in customize mode */
  display:               grid;
  grid-template-columns: repeat(12, 1fr);
  grid-auto-rows:        var(--row-h);
  gap:                   var(--gap);
}
.cell {
  grid-column: var(--col) / span var(--span);
  grid-row:    var(--row) / span var(--rows);
  background:  transparent;             /* the widget body provides the surface */
}
```

### Customize mode

Customize mode widens the gap from 1px → 16px, animated via `transition: gap 220ms cubic-bezier(0.4, 0, 0.2, 1)`. The grid also gets a dashed sky-tinted outline (`--accent-3` at low alpha) as the affordance.

The transition works because CSS Grid's `gap` is natively animatable in shipping browsers; the columns are `1fr` so they auto-resize as the gap interpolates, and the cards reflow smoothly.

### 1px gap pattern

Each widget body is `--bg-surface-2` (lighter); the parent is `--bg-surface` (darker). The 1px grid gap reveals the parent and reads as a borderless divider. Hover lifts the widget to `--bg-surface-3` — never recolor a border.

This is **the canonical implementation** of the tile-card pattern. Build any equivalent surface by reusing `Widget` (`src/ui/components/Widget/`), not by recreating the pattern.

---

## Widgets

Each widget is a `DashboardWidgetDefinition`:

```ts
interface DashboardWidgetDefinition {
  id:           string                          // 'storage', 'pages', 'activity', ...
  name:         string                          // 'Storage usage', 'Pages', ...
  description?: string
  defaultSize:  { span: DashboardWidgetSize; rows: number }
  tint:         DashboardWidgetTint             // 'mint' | 'lilac' | 'sky' | 'peach'
  icon?:        string                          // pixel-art-icons name
  render:       React.ComponentType<DashboardWidgetRendererProps>
  // capability gate — widget is hidden if user lacks this
  requires?:    CoreCapability
}
```

| Size  | Columns |
|-------|---------|
| 3     | quarter |
| 4     | third   |
| 6     | half    |
| 8     | two-thirds |
| 12    | full    |

`tint` maps to one of `--accent-1/lilac/sky/peach` — used for the widget's title dot and (optionally) the chart series color.

### First-party widgets

| id              | Default size | Tint     | Shows                                                |
|-----------------|--------------|----------|------------------------------------------------------|
| `visitors`      | 6 × 4        | mint     | Unique visitor count + sparkline (24h / 7d / 30d)    |
| `storage`       | 4 × 3        | sky      | Total disk usage + media/plugins/database breakdown bar    |
| `top-pages`     | 4 × 3        | lilac    | Top pages by traffic                                 |
| `posts`         | 4 × 2        | peach    | Total post count + per-day bars                      |
| `activity`      | 4 × 3        | peach    | Recent admin activity feed                           |
| `pages`         | 3 × 1        | lilac    | Total page count                                     |
| `media`         | 3 × 2        | peach    | File count + recent uploads thumbs                   |
| `status`        | 3 × 1        | mint     | Site / SSL / HTTPS status                            |
| `domain`        | 4 × 1        | sky      | Primary domain + verification status                 |
| `publish-queue` | 6 × 2        | mint     | Recently published + scheduled pages                 |
| `plugins`       | 4 × 1        | sky      | Installed plugin count                               |

Each widget is a small React component that fetches its own data via `useDashboardStats(...)` selectors and renders into a `<Widget tint="...">` wrapper.

### Plugin-contributed widgets

A plugin with the `dashboard.widgets.register` permission can register widgets via the SDK at activation time. The widget's React component runs in the **admin app context** (not the QuickJS sandbox) — plugin canvas modules run sandboxed, but admin / dashboard widgets render in-process.

---

## Drag and drop

`DashboardPage` owns one `DndContext` so two surfaces share a single dnd-kit session:

1. **The grid** — registers itself as one droppable (`GRID_DROP_ID`). Each cell becomes a `useDraggable` "move" source identified by widget id.
2. **The BlockLibrary** — registers each preview tile as a `useDraggable` with id `library:<widgetId>`.

The page-level `onDragEnd` handler distinguishes the two:

```text
drag source                      → handler does
---------------------------------|----------------------
existing cell (widgetId)         → move widget to drop cell
library tile (library:<id>)      → add widget at drop cell, remove from library
```

### Drop preview

A translucent ghost (`.dropPreview`) tracks the proposed drop cell. Positioned absolutely (not as a grid item) so its `top`/`left`/`width`/`height` can transition smoothly across cells. CSS Grid's `grid-column-start` isn't transitionable in all browsers; pixel coordinates are the cross-browser path.

The ghost is only shown when the destination is valid — if the proposed cell overlaps an existing widget, `dropTarget` is `null` and the ghost hides. The ghost disappearing IS the signal that the drop will be rejected.

### Resize handles

Each cell has 4 edge handles + 1 corner handle. Hover the cell to fade them in; hover a handle to make it brighter. The center accent rail (`--accent-3`) is the visible affordance; the actual grab box extends 8–14px around the edge.

Edge handles resize column span (left / right) or row span (top / bottom). The corner handle resizes both axes simultaneously and wins over the overlapping edge handles.

```text
┌─────────────────────────┐
│  ┌── top ──┐            │
│  │         │            │
│ left      right         │
│  │         │            │
│  └─ bottom ┘     [↘]    │   ← corner handle
└─────────────────────────┘
```

Resize math snaps to integer column / row deltas in `useDashboardLayout.ts`. The JS reads the same `GRID_ROW_HEIGHT` / `GRID_GAP` constants the CSS uses, so resize previews land on a pixel-accurate cell boundary.

---

## Layout persistence

`useDashboardLayout(...)` is the source of truth for widget positions, sizes, and order.

| Action            | What it writes                                          |
|-------------------|---------------------------------------------------------|
| Move widget       | `{ widgetId, col, row }`                                |
| Resize widget     | `{ widgetId, span, rows }`                              |
| Add from library  | Append `DashboardItem` to the user's layout            |
| Remove widget     | Remove from layout; widget returns to library          |

The layout is persisted server-side in the `user_preferences` table under key `dashboard-layout`. The endpoint is `PUT /admin/api/cms/me/preferences/dashboard-layout` (handled by `handleUserPreferencesRoutes`).

This is **per-user, not per-site** — every user has their own dashboard arrangement.

### Default layout

New users start with a default layout (first-party widgets pre-positioned). `useDashboardWidgets(...)` falls back to the default when no user layout exists.

---

## Stats endpoints

The dashboard fans out into **per-domain** endpoints under `/admin/api/cms/dashboard/<domain>`. Each widget owns one hook (`usePagesStats`, `useMediaStats`, `useStorageStats`, …) which hits exactly one endpoint, so widgets unblock independently and the slowest reader (Activity) never holds up the rest:

| Endpoint                       | Hook                       | Response shape (summary)                                                                              |
|--------------------------------|----------------------------|-------------------------------------------------------------------------------------------------------|
| `/dashboard/pages`             | `usePagesStats`            | `{ total, published, drafts, scheduled, deltaPublishedThisWeek }`                                     |
| `/dashboard/posts`             | `usePostsStats`            | `{ total, categories, scheduled, daily28 }`                                                           |
| `/dashboard/media`             | `useMediaStats`            | `{ count, totalBytes, latestThumbs[] }`                                                               |
| `/dashboard/plugins`           | `usePluginsStats`          | `{ total, active, disabled, errored, rows[] }`                                                        |
| `/dashboard/storage`           | `useStorageStats`          | `{ imageBytes, videoBytes, documentBytes, pluginBytes, databaseBytes, totalBytes, dialect }`          |
| `/dashboard/publish-lineup`    | `usePublishLineupStats`    | `{ rows: [{ id, path, status, at }] }`                                                                |
| `/dashboard/activity`          | `useRecentActivityStats`   | `{ rows: [{ id, action, actor, targetCode, targetText, createdAt }] }`                                |

### Timezone-aware day bucketing

Every dashboard stats request includes a `?tz=<IANA>` query parameter (`Intl.DateTimeFormat().resolvedOptions().timeZone` from the viewer's browser). The server reads it in `handleDashboardRoutes` via `resolveTimeZone` (`server/time.ts`) and threads the resolved zone into `DashboardRequestContext.timeZone`. Readers that bin timestamps per calendar day — currently the Posts histogram — use `localDayKeyFactory(ctx.timeZone)` to map each `published_at` to a local day key rather than the UTC date. A post published at 23:30 local time lands on the correct bar instead of rolling into the next UTC day.

Endpoints that don't bin timestamps receive the `?tz=` param but ignore it. The shared utility lives in `server/time.ts` alongside `resolveTimeZone` (which falls back to `'UTC'` for missing or unrecognised zones) and `localDayKeyFactory` (which wraps `Intl.DateTimeFormat` with the `en-CA` locale so the key format is always `YYYY-MM-DD`).

### Storage sizing

`/dashboard/storage` is the only endpoint that combines a SQL aggregate, a filesystem walk, and a dialect-aware database probe:

- **`imageBytes` / `videoBytes` / `documentBytes`** — `coalesce(sum(case when mime_type like 'image/%' then size_bytes else 0 end), 0)` (and the matching `video/%` / fallback bucket) over active `media_assets`. Anything that isn't `image/*` or `video/*` — audio, PDFs, archives, rows with NULL mime_type — sums into `documentBytes`, so the three sub-counters add up to the full media total.
- **`pluginBytes`** — recursive `fs.stat` walk of `<uploadsDir>/plugins/`.
- **`databaseBytes`** — SQLite stats the `.db` file plus its `-wal` / `-shm` sidecars when present; Postgres runs `select pg_database_size(current_database())`.
- **`dialect`** — `db.dialect`, surfaced verbatim so the widget caption can show "SQLite" / "Postgres".

There is **no quota** — self-hosted Instatic never imposes an artificial disk cap, so the widget shows real usage and stretches its breakdown bar to fill the full width.

`useDashboardStats(...)` fetches once on mount and refreshes when the user toggles between 24h / 7d / 30d ranges (for visitors).

---

## Onboarding panel

`OnboardingPanel` is a first-run checklist shown at the top of the dashboard:

- [ ] Add your first page
- [ ] Connect a domain
- [ ] Set up a publish target
- [ ] Invite collaborators
- [ ] Customize your dashboard

State lives in `useOnboardingState(...)`. Items are marked complete based on live CMS state (e.g. "Add your first page" toggles complete when `pages.count > 0`).

The panel is dismissible — per-user, persisted to localStorage as `instatic-onboarding-dismissed`. Once dismissed, it doesn't return unless the user explicitly resets onboarding.

---

## Cookbook

### Register a first-party widget

```ts
// src/admin/pages/dashboard/widgets/MyWidget.tsx
import { type DashboardWidgetDefinition } from '@core/dashboard/types'
import { Widget } from '@ui/components/Widget'

export const MyWidget: DashboardWidgetDefinition = {
  id: 'my-stat',
  name: 'My stat',
  description: 'Custom stat tile',
  defaultSize: { span: 4, rows: 2 },
  tint: 'sky',
  icon: 'ChartBar',
  render: ({ stats }) => (
    <Widget tint="sky" title="MY STAT">
      <div>{stats.someValue}</div>
    </Widget>
  ),
}
```

Register it in `src/admin/pages/dashboard/widgets/index.ts`:

```ts
import { MyWidget } from './MyWidget'
import { dashboardWidgetRegistry } from '@core/dashboard'

export function registerFirstPartyDashboardWidgets() {
  // ... existing widgets
  dashboardWidgetRegistry.register(MyWidget)
}
```

That's it. Users see it in the BlockLibrary; dragging it onto the grid persists the layout.

### Register a plugin widget

Plugins with `dashboard.widgets.register` permission register widgets via the SDK at activation time. The widget's `render` function runs in the **admin React app** (not the QuickJS sandbox). Plugin canvas modules run sandboxed; plugin dashboard widgets do not.

### Gate a widget on capability

```ts
const AuditLogWidget: DashboardWidgetDefinition = {
  id: 'audit-log',
  name: 'Recent admin activity',
  defaultSize: { span: 6, rows: 3 },
  tint: 'peach',
  requires: 'audit.read',           // hidden if user lacks the capability
  render: (props) => <Widget tint="peach" title="ACTIVITY">...</Widget>,
}
```

`useDashboardWidgets` filters by `user.capabilities` — widgets without the required capability never appear in the BlockLibrary or render in the grid.

### Add a new size to the grid

Sizes are constrained to `3 | 4 | 6 | 8 | 12` (factors of 12). Add a new value:

1. Update `DashboardWidgetSize` in `src/core/dashboard/types.ts`.
2. Update the BlockLibrary's preview tile (each library tile shows its `defaultSize`).
3. Update the grid math in `useDashboardLayout.ts` if the new size needs special handling (it usually doesn't — CSS Grid handles it).

### Reset to default layout

Settings → Reset Dashboard Layout calls `useDashboardLayout(...).reset()`, which `DELETE`s the user's saved layout. The next render falls back to the default.

---

## Forbidden patterns

| Pattern                                                            | Use instead                                              |
|--------------------------------------------------------------------|----------------------------------------------------------|
| Recreating the borderless-tile-card look manually                  | `<Widget tint="...">`                                    |
| Using `--bg-body` (pure black) as a widget body fill             | `--bg-surface-2` — the gap reveals the parent       |
| Hovering changes a border instead of a tone                        | Background tone lift (`-surface-2` → `-3`)               |
| Inventing a new size (e.g. 5 columns)                              | Stay with the factor-of-12 grid sizes                    |
| Dispatching dashboard data through the editor store                | Use `useDashboardStats` — the dashboard is self-contained|
| Adding pages-specific UI to a widget                               | Widgets are for read-only KPIs / activity. Use a workspace for editing. |
| Hardcoding a widget's position in the default layout JSON          | Add it to the default layout in `useDashboardWidgets`; users can move it. |
| Reading `useEditorStore` from inside a widget                      | The dashboard is in the admin shell, not the editor — the editor store isn't mounted here. |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview (`/admin/dashboard` workspace)
- [docs/editor.md](../editor.md) — broader admin shell
- [docs/design.md](../design.md) — the borderless-tile-card pattern
- [docs/reference/ui-primitives.md](../reference/ui-primitives.md) — `Widget`, `WidgetList`, `LiquidProgressRing`, charts
- [docs/reference/design-tokens.md](../reference/design-tokens.md) — `--accent-*`, `--bg-surface-*`
- Source-of-truth files:
  - `src/admin/pages/dashboard/DashboardPage.tsx` — page entrypoint
  - `src/admin/pages/dashboard/components/DashboardGrid.tsx` / `.module.css` — canonical grid implementation
  - `src/admin/pages/dashboard/widgets/index.ts` — first-party registration
  - `src/core/dashboard/registry.ts` — registry singleton
  - `src/core/dashboard/types.ts` — `DashboardWidgetDefinition`
  - `src/admin/pages/dashboard/hooks/useDashboardLayout.ts` — layout state + DnD
  - `src/admin/pages/dashboard/hooks/useDashboardStats.ts` — stats fetch
  - `server/handlers/cms/dashboard/index.ts` — `/admin/api/cms/dashboard` route handler + endpoint registry
  - `server/handlers/cms/dashboard/types.ts` — every response shape + `DashboardRequestContext`
  - `server/handlers/cms/dashboard/posts.ts` — Posts widget reader (timezone-aware histogram)
  - `server/time.ts` — `resolveTimeZone` + `localDayKeyFactory` (shared day-bucketing utilities)
- Structural gates:
  - `src/__tests__/architecture/css-token-policy.test.ts`
  - `src/__tests__/architecture/noTailwindUtilities.test.ts`
  - `src/__tests__/architecture/button-primitive-usage.test.ts`
