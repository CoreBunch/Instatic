# Admin i18n

Simplified Chinese and English localization infrastructure and coverage for the admin application.

The admin defaults to English (`en`). An explicit language choice is persisted locally, updates `<html lang>`, and is available before and after authentication. Existing Chinese preferences are preserved. Published-site language remains a separate setting.

---

## TL;DR

- `src/admin/i18n/catalog.ts` contains strongly typed, named messages used by authentication and application-level UI.
- English source literals in admin components are gettext-style message IDs. `scripts/lib/adminI18n.ts` extracts supported user-facing contexts and the Vite pre-transform injects English plus Simplified Chinese at build time.
- Simplified Chinese literal catalogs live in `src/admin/i18n/locales/zh-CN/`, split by workspace so the source remains reviewable.
- `src/admin/i18n/runtime.ts` selects the already bundled literal for the active locale. Each route chunk carries only its own translated strings; the entry chunk does not import the complete catalog.
- Admin date and number formatters use `getActiveAdminLocale()` from `src/admin/i18n/`. The scheduling dialog passes the locale and translated labels to the shared `DateTimePicker`; the primitive has no admin dependency.
- Shared primitive chrome (select menus, search, dialogs, notifications, spinners, widgets, and error boundaries) uses `src/ui/i18n/`. `I18nProvider` supplies the typed catalog from `src/admin/i18n/uiMessages.ts`; standalone primitives retain English defaults.
- `I18nProvider` owns the locale, remounts its child tree after a language change, and synchronizes the document language.
- `instatic-admin-locale-v1` is TypeBox-validated. Missing, invalid, or inaccessible storage falls back to English, regardless of the browser language. Clearing the preference in another tab also restores English.
- `admin-i18n-coverage.test.ts` fails when a newly introduced admin message has no Simplified Chinese translation.

## Architecture

| Responsibility | Source of truth |
|---|---|
| Supported locales and named messages | `src/admin/i18n/catalog.ts` |
| Workspace literal catalogs | `src/admin/i18n/locales/zh-CN/*.ts` |
| Combined build-time catalog | `src/admin/i18n/literalCatalog.ts` |
| Extraction and Vite transformation | `scripts/lib/adminI18n.ts` |
| Runtime literal selection | `src/admin/i18n/runtime.ts` |
| React context and document synchronization | `src/admin/i18n/I18nProvider.tsx` |
| Persisted preference | `src/admin/i18n/localePreference.ts` |
| Pre-auth switch | `src/admin/i18n/LanguageSwitcher.tsx` |
| Authenticated switch | `src/admin/shared/AccountMenuButton/AccountMenuButton.tsx` |
| Coverage gate | `src/__tests__/architecture/admin-i18n-coverage.test.ts` |
| Shared UI copy and context | `src/ui/i18n/` + `src/admin/i18n/uiMessages.ts` |

Locale resolution is deliberately simple:

```text
validated localStorage preference
  → English default
```

The language control remains available on the setup/login screen and in the authenticated account menu. Changing it persists the preference and remounts the admin subtree so module-level configuration getters and all rendered literals resolve against one locale.

## Two message forms

Use a named message for application infrastructure, messages shared across unrelated contexts, or interpolation that benefits from a semantic key:

```tsx
import { useI18n } from '@admin/i18n'

export function Example() {
  const { t } = useI18n()
  return <h1>{t('preauth.setup.title')}</h1>
}
```

Regular admin component copy stays readable in place:

```tsx
<Button aria-label="Open Settings">Settings</Button>
```

The build transform recognizes visible JSX text, accessible text attributes, custom props ending in `Label`, `Title`, `Description`, `Tooltip`, `Placeholder`, `Message`, or `Hint`, their parameter/destructuring defaults, subtitles (`eyebrow`, `meta`), render-time string branches, selected UI configuration properties such as `title`, `label`, `description`, and `fallbackError`, and user-message setters. It rewrites only messages present in the Chinese catalog, while the coverage gate ensures the recognized set is complete. Form `value`, layout `body` enums, and caller data are not translated; expose static display copy through a named message or a render-time `*Label`/`*Message` variable instead.

Parameterized template literals use positional placeholders in the literal catalog:

```ts
"{0} items": "{0} 项"
```

Run the report while migrating or reviewing copy:

```bash
bun scripts/admin-i18n-report.ts --missing
bun scripts/admin-i18n-report.ts --area=site --missing
```

## Adding or changing copy

1. Write the English UI copy in its component or named catalog.
2. Run `bun scripts/admin-i18n-report.ts --missing`.
3. Add each missing literal to the appropriate `src/admin/i18n/locales/zh-CN/` catalog.
4. Run the architecture gate and build. The production build is the authoritative transform check.

## Boundaries and gotchas

- Do not translate user content, site names, plugin-provided labels, URLs, source code, CSS values, or internal identifiers. The extractor intentionally limits itself to known UI contexts rather than rewriting arbitrary string literals.
- A zero-missing report covers extracted first-party admin messages, not arbitrary runtime text. Server/provider error details, compiler diagnostics, and third-party plugin UI retain their original text.
- Use whole singular/plural sentences, not English grammatical fragments inside placeholders. Keep runtime values (names, counts, paths) as parameters.
- JSX entities are decoded before extraction and replacement so English text still displays `&`, quotes, and non-breaking spaces correctly. Ordinary TypeScript strings are not entity-decoded.
- For helper messages outside supported extraction contexts, use named keys with `translate(getActiveAdminLocale(), key, params)` instead of relying on a variable's name being detected.
- Shared UI primitives receive translated copy through `UiMessagesContext` or explicit props, and formatting locales from their admin caller. Do not import `@admin/i18n` into `src/ui/` or rewrite CMS content for display localization. The architecture gate checks this layer boundary and extracted primitive literals; `src/__tests__/admin/uiI18n.test.tsx` checks catalog and placeholder parity.

## Adding a locale

1. Add the locale tag and named catalog to `src/admin/i18n/catalog.ts`.
2. Extend `AdminLocalePreferenceSchema` in `localePreference.ts`.
3. Add a literal catalog for the locale and pass it to the build transform.
4. Add the locale to both language controls.
5. Cover persistence, named interpolation, literal transformation, and a rendered page in tests.

## Remaining coverage boundaries from the UI audit

- The admin source report does not yet cover built-in module metadata under `src/modules/` (for example, the Text/Container/Image insertion labels and module property labels). These need an admin presentation-layer translation; do not change module IDs, property values, or published content.
- Persisted system table/field/role names can still appear in English (for example, Pages, Title, and Owner). Their display localization needs to distinguish shipped system metadata from author-defined names; do not rename stored data to match the current admin locale.
- User-authored document/breakpoint names, plugin-authored interfaces, and provider/compiler error details are not translated by the admin literal transform.
- The browser smoke pass checks setup, language persistence, and the default dashboard/site/content/data/media/plugins/AI/users workspaces on desktop. It is not an exhaustive audit of every modal, permission state, or third-party plugin.

## Related

- `docs/editor.md` — admin SPA boot and provider placement.
- `docs/reference/persistence-keys.md` — client preference key catalog.
- `docs/reference/typebox-patterns.md` — persisted-boundary validation.
