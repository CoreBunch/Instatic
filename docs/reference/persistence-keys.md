# Persistence Keys

Catalog of every `localStorage` / `sessionStorage` key the admin app writes, and the persistent server-side preference rows. One page to answer "where does X live?".

---

## TL;DR

- All client-side persistence keys are prefixed `instatic-` (or `spotlight:` for Spotlight-specific ones). Don't collide with site / module CSS class names.
- All server-side per-user preferences live in `user_preferences` rows keyed by `user_id` + `key`.
- Reads go through `parseJsonWithFallback(...)` (corrupted data falls back to defaults) — see [docs/reference/typebox-patterns.md](typebox-patterns.md).
- The convention: `instatic-<feature>[-v<version>]`. Bumping `-v<N>` invalidates older shapes silently (the schema's `additionalProperties: true` keeps reads tolerant).

---

## Client-side keys

### localStorage

| Key                                       | Owner                                                                 | Source-of-truth file                                            |
|-------------------------------------------|-----------------------------------------------------------------------|-----------------------------------------------------------------|
| `instatic-editor-prefs`                         | All editor preferences (auto-save, hover-preview, density, layers options) — see [docs/features/editor-preferences.md](../features/editor-preferences.md) | `src/admin/pages/site/preferences/editorPreferences.ts` → `EDITOR_PREFS_KEY` |
| `instatic-editor-layout-v2`                     | Per-workspace sidebar widths + open states (site / content / data / media) and floating panel positions | `src/admin/state/workspaceLayoutStorage.ts` → `EDITOR_LAYOUT_STORAGE_KEY` |
| `instatic-clipboard-v1`                         | The editor clipboard (copy / cut / paste of layer subtrees)            | `src/admin/pages/site/store/clipboard/clipboardStorage.ts` → `CLIPBOARD_STORAGE_KEY` |
| `instatic-class-usage`                          | Recently-used classes in the ClassPicker autocomplete                 | `src/admin/pages/site/preferences/classUsage.ts` → `CLASS_USAGE_STORAGE_KEY` |
| `instatic-data-grid-primary-widths-v1`          | Per-table primary-column widths in the Data workspace grid            | `src/admin/pages/data/components/DataGrid/usePrimaryColumnWidth.ts` |
| `instatic-media-page-view-mode`                 | Media workspace view mode (grid / list / large thumbs)                | `src/admin/pages/media/components/MediaCanvas/MediaCanvas.tsx`   |
| `instatic-media-explorer-view-mode`             | Media Explorer panel view mode (site workspace)                       | `src/admin/pages/site/panels/MediaExplorerPanel/mediaExplorerUtils.ts` → `VIEW_MODE_STORAGE_KEY` |
| `instatic-module-inserter-v1`                   | Module inserter view mode and recent inserts | `src/admin/pages/site/module-picker/moduleInserterPrefs.ts`      |
| `instatic-onboarding-dismissed`                 | Dashboard onboarding panel: dismissed / open per-device              | `src/admin/pages/dashboard/hooks/useOnboardingState.ts`         |
| `spotlight:recent-commands`               | Spotlight recents — last N executed command ids                       | `src/admin/spotlight/recentStore.ts`                            |
| `spotlight:telemetry:v1`                  | Local Spotlight telemetry (command frequency)                         | `src/admin/spotlight/telemetry.ts`                              |

### sessionStorage

| Key                                       | Owner                                                                 | Source-of-truth file                                            |
|-------------------------------------------|-----------------------------------------------------------------------|-----------------------------------------------------------------|
| `instatic-spotlight-pending-action`             | The cross-page-reload action a Spotlight command is waiting for (e.g. step-up then resume) | `src/admin/spotlight/pendingAction.ts`             |

### Cookies (HttpOnly — not directly readable)

| Cookie                                    | Owner                                                                 | Source-of-truth file                                            |
|-------------------------------------------|-----------------------------------------------------------------------|-----------------------------------------------------------------|
| `instatic_admin_session`                        | Admin session token (raw; hashed before lookup)                       | `server/auth/tokens.ts` → `SESSION_COOKIE_NAME`                 |

The session cookie is `HttpOnly`, `Secure` (in production behind TLS), `SameSite=Lax`, `Path=/admin`. The client never reads it directly.

---

## Server-side per-user preferences

Stored in the `user_preferences` table — one row per `(user_id, key)`. Keys are namespaced under `instatic-`. Persisted server-side so they sync across devices.

| Key                                       | Owner                                                                 | Source-of-truth file                                            |
|-------------------------------------------|-----------------------------------------------------------------------|-----------------------------------------------------------------|
| `dashboard-layout`                        | Dashboard widget positions / sizes                                     | `src/admin/pages/dashboard/hooks/useDashboardLayout.ts`         |
| `module-inserter`                         | Module inserter notch favorites: ordered `{ kind, id }` refs for modules, layouts, and Visual Components | `src/admin/pages/site/module-picker/useModuleInserterPreference.ts` |

### Endpoint

```text
GET    /admin/api/cms/me/preferences/:key       → { value } | { value: null } when unset
PUT    /admin/api/cms/me/preferences/:key       → save value
DELETE /admin/api/cms/me/preferences/:key       → reset
```

An unset preference returns `200 { value: null }` (not a 404) — these prefs
are all optional and the client falls back to its own default, so a 404 would
just be console noise that reads like a real failure.

Handler: `server/handlers/cms/userPreferences.ts`. Capability: any authenticated user can manage their own preferences.

The value is JSON, validated against a per-key TypeBox schema. The repository is `server/repositories/userPreferences.ts`.

---

## Reading

The pattern is always:

```ts
import { safeParseJson, parseJsonWithFallback } from '@core/utils/jsonValidate'

// Hard: corruption is an error
const result = safeParseJson(localStorage.getItem('instatic-...') ?? '', Schema)
if (!result.ok) throw result.error

// Soft (typical): corruption falls back to defaults
const value = parseJsonWithFallback(
  localStorage.getItem('instatic-...') ?? '',
  Schema,
  DEFAULTS,
)
```

`parseJsonWithFallback` is the default. The user shouldn't see a broken editor because their localStorage got truncated. See [docs/reference/typebox-patterns.md](typebox-patterns.md).

---

## Writing

```ts
import { Type } from '@core/utils/typeboxHelpers'

const Schema = Type.Object({
  view: Type.Union([Type.Literal('grid'), Type.Literal('list')]),
}, { additionalProperties: true })

const next = { view: 'grid' as const }
localStorage.setItem('instatic-...', JSON.stringify(next))
```

`additionalProperties: true` on the schema lets older clients read newer data (unknown keys are preserved on round-trip) — important when a feature ships a new key while existing tabs are still running the old code.

---

## Versioning

When a stored shape changes incompatibly, bump the suffix:

```text
instatic-editor-layout-v2    →    instatic-editor-layout-v3
```

The old key stays in localStorage for users who haven't upgraded; the new key starts fresh. Don't migrate — let the old data be GC'd by the user agent over time.

`additionalProperties: true` covers the common case (a new optional field). Use the `-vN` bump only when a field's **shape** changes (an object becomes an array, an enum value is removed).

---

## Cookbook

### Add a new persisted preference

```ts
// src/admin/pages/site/preferences/myFeature.ts
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'

const KEY = 'instatic-my-feature-v1'

const Schema = Type.Object({
  enabled:  Type.Boolean(),
  threshold: Type.Number(),
}, { additionalProperties: true })

type Prefs = Static<typeof Schema>
const DEFAULTS: Prefs = { enabled: true, threshold: 5 }

export function readMyFeaturePrefs(): Prefs {
  return parseJsonWithFallback(localStorage.getItem(KEY) ?? '', Schema, DEFAULTS)
}

export function writeMyFeaturePrefs(prefs: Prefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs))
}
```

If the feature is editor-wide, prefer adding to `PREFERENCE_CATALOG` in `editorPreferences.ts` — the Settings UI auto-renders the toggle.

### Add a server-persisted preference

```ts
// server/repositories/userPreferences.ts (extend)
const MY_FEATURE_KEY = 'my-feature'

export async function getMyFeature(db, userId): Promise<MyFeaturePrefs> {
  const row = await getUserPreference(db, userId, MY_FEATURE_KEY)
  return row ? parseValue(MyFeatureSchema, row.value_json) : MY_FEATURE_DEFAULTS
}
```

Add the matching client-side hook that fetches `GET /me/preferences/my-feature`. See [docs/features/editor-preferences.md](../features/editor-preferences.md) for the broader pattern (most editor prefs go in the catalog).

### Clear a key for testing

`localStorage.removeItem('instatic-...')` resets the user's state. The next read falls back to defaults.

For end-to-end tests, the canonical reset is to clear all `instatic-` keys:

```ts
for (const key of Object.keys(localStorage)) {
  if (key.startsWith('instatic-') || key.startsWith('spotlight:')) {
    localStorage.removeItem(key)
  }
}
```

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| Storing keys without a `instatic-` prefix                                  | Always prefix `instatic-` (or `spotlight:` for spotlight-owned) |
| `JSON.parse(localStorage.getItem('instatic-...') ?? '{}')`                 | `parseJsonWithFallback(raw, Schema, DEFAULTS)`           |
| Catching `JSON.parse` errors silently                                | The helpers do it for you                                |
| Storing secrets (tokens, passwords) in localStorage                  | Cookies (`HttpOnly`) are the only place secrets live    |
| Cross-tab broadcasting via setTimeout polling                        | Use the native `storage` event (cross-tab) or a CustomEvent (same tab) — see `editorPreferences.ts` for the pattern |
| Storing large blobs in localStorage (>1MB)                           | Use IndexedDB (rare — most CMS state is server-side)     |
| Using session storage for things that should survive page reload     | localStorage. session is for in-flight cross-redirect state. |
| Versioning by editing the schema in place without bumping the key    | Bump `-vN` when shape changes incompatibly               |

---

## Related

- [docs/features/editor-preferences.md](../features/editor-preferences.md) — the canonical preference catalog
- [docs/features/dashboard.md](../features/dashboard.md) — dashboard layout persistence
- [docs/features/spotlight.md](../features/spotlight.md) — Spotlight recents + telemetry
- [docs/reference/typebox-patterns.md](typebox-patterns.md) — `parseJsonWithFallback`, `safeParseJson`
- Source-of-truth files (selected):
  - `src/admin/pages/site/preferences/editorPreferences.ts` — `EDITOR_PREFS_KEY`
  - `src/admin/state/workspaceLayoutStorage.ts` — `EDITOR_LAYOUT_STORAGE_KEY`
  - `src/admin/pages/site/store/clipboard/clipboardStorage.ts` — `CLIPBOARD_STORAGE_KEY`
  - `src/admin/spotlight/recentStore.ts` — Spotlight recents
  - `server/repositories/userPreferences.ts` — server-side `user_preferences` rows
  - `server/handlers/cms/userPreferences.ts` — `/admin/api/cms/me/preferences/:key`
