# Admin i18n

Simplified Chinese and English localization for the complete admin application.

The admin defaults to Simplified Chinese (`zh-CN`). An explicit language choice is persisted locally, updates `<html lang>`, and is available before and after authentication. Published-site language remains a separate setting.

---

## TL;DR

- `src/admin/i18n/catalog.ts` contains strongly typed, named messages used by authentication and application-level UI.
- English source literals in admin components are gettext-style message IDs. `scripts/lib/adminI18n.ts` extracts supported user-facing contexts and the Vite pre-transform injects English plus Simplified Chinese at build time.
- Simplified Chinese literal catalogs live in `src/admin/i18n/locales/zh-CN/`, split by workspace so the source remains reviewable.
- `src/admin/i18n/runtime.ts` selects the already bundled literal for the active locale. Each route chunk carries only its own translated strings; the entry chunk does not import the complete catalog.
- `I18nProvider` owns the locale, remounts its child tree after a language change, and synchronizes the document language.
- `instatic-admin-locale-v1` is TypeBox-validated. With no saved preference, the admin always starts in Simplified Chinese.
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

Locale resolution is deliberately simple:

```text
validated localStorage preference
  → Simplified Chinese default
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

The build transform recognizes visible JSX text, accessible text attributes, render-time string branches, selected UI configuration properties such as `title`, `label`, and `description`, and user-message setters. It rewrites only messages present in the Chinese catalog, while the coverage gate ensures the recognized set is complete.

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

Do not translate user content, site names, plugin-provided labels, URLs, source code, CSS values, or internal identifiers. The extractor intentionally limits itself to known UI contexts rather than rewriting arbitrary string literals.

## Adding a locale

1. Add the locale tag and named catalog to `src/admin/i18n/catalog.ts`.
2. Extend `AdminLocalePreferenceSchema` in `localePreference.ts`.
3. Add a literal catalog for the locale and pass it to the build transform.
4. Add the locale to both language controls.
5. Cover persistence, named interpolation, literal transformation, and a rendered page in tests.

## Related

- `docs/editor.md` — admin SPA boot and provider placement.
- `docs/reference/persistence-keys.md` — client preference key catalog.
- `docs/reference/typebox-patterns.md` — persisted-boundary validation.
