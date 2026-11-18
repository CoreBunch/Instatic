# Dependencies

The Site → Dependencies panel is where a site's npm packages are found, inspected, installed and removed.

It browses the whole registry through a server-side proxy, and every install lands in the site's `package.json` (`SitePackageJson`, see [`site-shell.md`](site-shell.md)) where the runtime resolver turns it into a locked, self-hosted package the published page can import. The source of truth for every proxied shape is `src/core/registry/schemas.ts`; for what a site declares it is `SitePackageJsonSchema` in `src/core/site-dependencies/manifest.ts`.

---

## TL;DR

- **Panel:** `src/admin/pages/site/panels/DependenciesPanel/`. `RegistryPanel` owns one search box; an empty query shows `HomeView` (installed packages, and on the public registry a curated "popular for sites" set plus category shortcuts), typing shows `ResultsView`, opening anything shows `PackageDetailView` with a sticky `InstallControl`.
- **Registry access is server-side only.** The browser never talks to npm. `server/handlers/cms/registry.ts` exposes six read-only routes on the `site.read` floor; `server/registry/client.ts` does the upstream reads with a bounded TTL cache.
- **Shared shapes:** `@core/registry` — TypeBox schemas for every proxied response, `pickEsmEntry` (the importmap builder's entry rules, reused as a pre-install compatibility badge), `cleanPackageDescription`.
- **Installing is a store mutation.** `setDependency(name, range, dev)` writes the manifest; `useAutoResolveDependencies` (mounted by the editor) posts to `/runtime/dependencies/resolve`, which resolves, `bun install`s and returns the lock + importmap. Removing is `removeDependency(name)` behind the editor's confirm-delete dialog (`useConfirmDelete`), always confirmed because a manifest change reaches past the editor, and it never needs the registry to answer.
- **Capabilities:** browsing needs `site.read`; install, remove, resolve and the runtime-issue actions need `runtime.dependencies`. Without it the controls stay visible but disabled, with the reason as their tooltip, rather than failing on click.
- **Config:** `NPM_REGISTRY_URL` (parsed once by `readServerConfig`, applied through `configureNpmRegistryUrl`) points search, packuments, the resolver and `bun install` at one registry (default `https://registry.npmjs.org`). `GET /admin/api/cms/registry` tells the panel the registry's host and whether it is the public one (`RegistryProfile`); only the public registry gets npm's search qualifiers, download statistics (`api.npmjs.org`), OSV advisories and npmjs.com links. A private registry gets plain search and packuments, its package names never leave the server, and the home view drops the npm-only sections. A profile that fails to load is not treated as private: the panel shows the error with a retry, because silently hiding half the panel would be indistinguishable from a mirror.

---

## The panel

```text
RegistryPanel                 search box · runtime-issue banner · view switch
├── HomeView                  Installed (+ resolve status) · Dev dependencies · [public npm] Popular for sites · Browse by category
├── ResultsView               result tiles · sort (match / popular / updated) · show more
└── PackageDetailView         hero · badges · keywords · stat tiles · Readme | Versions | Deps | Security · links
    └── InstallControl        version picker + Install (split: dev dependency) | installed pill + Remove (confirm dialog)
```

Loading states mirror what they replace (`PackageSkeletons.tsx`): the results placeholder is a run of result-shaped tiles and the package page is a hero plus stat tiles, both reusing the real tile classes so radius and spacing cannot drift from the loaded state.

Data hooks live in `useRegistryData.ts` (the registry profile, a paged search accumulator whose page count lives under the query key, one `useAsyncResource` per other request; the proxy's `Cache-Control` lets the browser cache absorb repeats) and `useInstalledDependencies.ts` (store selectors, usage map, runtime-issue summary, lock sync, resolve status, capability gate). Manifest reads go through `readDeclaredDependency` in `src/core/site-dependencies/manifest.ts`, which uses `Object.hasOwn`: `isSafePackageName` accepts `constructor`, and a bare `in` or bracket read would report it installed with a `Function` for a version. The store's add/remove guards and the module engine read through the same helper. `curated.ts` holds the npm-only editorial content (popular packages with our own one-line blurbs, category shortcuts); reading those blurbs from the registry would cost eight parallel search calls on every panel open. Badges, keywords and version numbers are the shared `TagPill` primitive: keywords and factual signals take the categorical accent it derives from the label, while `ESM` / `main only` / `no entry` / `deprecated` / `insecure` carry its state tones, so the panel's chips match every other tag in the editor. `PackageTiles.tsx` holds the presentational pieces and the shared row classes; its `Tile` renders through the `Button` primitive (ghost, start-aligned) with the tile chrome layered on by class, the same way the module inserter's tile items do. Empty sections use the `EmptyState` primitive inside a static tile; hover hints on the package page use the `Tooltip` primitive, never `title=`.

Visual rules follow [`../design.md`](../design.md) ("Cards are tiles, not boxes"): borderless `--bg-surface-2` tiles on the sidebar's `--bg-surface` with a 1px gap and `--card-radius`; each package gets an identity accent through `railAccent(name)` (`tint.ts`) for its monogram and sparkline; state colour is reserved for installed / update-available / security.

### What the user sees per package

| Signal | Source |
|---|---|
| Weekly downloads, sparkline | `GET …/packages/:name/downloads` (30 daily points, `weekly` = last 7; `null` when the registry has no stats) |
| Install version choices | `latest`, then the other dist-tags, then the newest non-deprecated releases (`packageVersions.ts`); the first entry is the one-click default, and the tags precede the capped release list so a `next` build stays reachable |
| Dependents, publisher | the search-index hit the user came from, or one exact-name lookup (`usePackageHit`) |
| TS / ESM / main only / no entry badges | `RegistryVersionInfo.hasTypes` + `esmEntry` from `pickEsmEntry` on the latest manifest |
| deprecated / insecure | packument `deprecated`, search-index `flags.insecure` |
| README | packument `readme` → `renderMarkdownToHtml` → `sanitizeRichtext(html, MARKDOWN_DOCUMENT_CONFIG)` (`readmeHtml.ts`), rendered once per package page |
| Versions (newest 100 of N), dist-tags, sizes | packument `versions` + `time`; `versionCount` carries the full total |
| License | the latest version's, or the packument-level one for old packages |
| Security | `POST api.osv.dev/v1/query` for the latest version (public npm only) |
| Update available (installed rows) | `GET …/packages/:name/latest` vs the locked version |
| in use | `analyzeRuntimeScriptImports` + `getSiteModuleDependencyUsage` (`runtimeIssues.ts`) |

Runtime-script diagnostics (`runtime-dependency-missing`, `-dev-only`, `-node-builtin`, `-invalid-name`) render above the home and results views as the "Runtime dependency issues" group with **Add** / **Move** actions, exactly the surface `tests/e2e/runtime-dependencies.e2e.ts` drives.

A package the search index does not list (just published, deprecated, or a private registry without `/-/v1/search`) is still reachable: a typed name that is a valid package name gets an "Open package" tile above the results, and Enter opens that name directly. The package page fetches the packument by name, so it works whenever the registry does. A search endpoint that answers 404 counts as an empty result, not an error.

Installing writes the manifest; the resolve that follows runs in `useAutoResolveDependencies`, which the editor body mounts alongside the panel. A failed resolve shows its message and a **Retry resolve** button both on the package page's install bar and in the home view's Installed title. The install bar renders for an installed package even while its details are loading or failed, so a typo'd or vanished package can always be removed.

---

## The proxy

```text
GET /admin/api/cms/registry                             → RegistryProfile { host, publicNpm }
GET /admin/api/cms/registry/search?q=&sort=relevance|popularity|maintenance&from=&size=&deprecated=hide|show
GET /admin/api/cms/registry/packages/:name              → RegistryPackageDetails
GET /admin/api/cms/registry/packages/:name/latest       → { version | null }
GET /admin/api/cms/registry/packages/:name/downloads    → { daily[], weekly | null }
GET /admin/api/cms/registry/packages/:name/advisories?version=  → { advisories[] }
```

- Scoped names travel URL-encoded (`@scope%2Fname`); the route-table dispatcher decodes once and the handler validates with `isSafePackageName` before the name touches a URL. Query params are validated with TypeBox (`q` 1–200 chars, `size` ≤ 50, `from` ≤ `REGISTRY_MAX_SEARCH_FROM`); that bound and the page size are exported from `@core/registry`, so the panel's paging and the route's validation cannot drift. `deprecated=hide` appends npm's `not:deprecated` qualifier on the public registry only; a private registry would match it as literal text.
- The registry host is server config only (`npmRegistryUrl()` in `server/registry/config.ts`); nothing in a request can redirect a read. A malformed `NPM_REGISTRY_URL` logs a warning and falls back to the public registry. The profile route exposes the host, never the URL, which may carry credentials.
- Upstream failures map to `502` (`RegistryUpstreamError` status / network / shape / too-large), `504` (timeout) and `404` (unknown package); the panel shows them inline with a retry. Budgets cover the whole exchange, body included: 10 s for search and stats, 30 s for a full packument, 60 s for an install document (what `bun install` gets). Bodies are counted as they arrive and refused past 32 MB, so neither compression nor chunked encoding can hide a document's real size. A caller's `AbortSignal` is honoured only for uncached reads: a cached load is shared by every caller on that key, and letting the first one cancel it would fail the rest.
- Responses carry `Cache-Control: private, max-age=…` derived from the one `TTL` table in `client.ts` (search 5 min, details and latest 10 min, downloads 6 h, advisories 1 h) so the browser cache backs the server's `TtlCache` (`server/registry/cache.ts`: one TTL per cache, insertion order is expiry order, bounded, single-flight loads). Injecting `fetchImpl` (tests) bypasses the caches.
- Only projections are cached (`RegistryPackageDetails`, search pages, stats), never raw packuments: a popular packument is tens of megabytes of JSON. Package details project only the newest 100 versions plus every dist-tagged version (ordered by publish time, falling back to semver when the packument carries no `time`, so `latest` is always present), `versionCount` carries the real total, a dist-tag whose version is gone is dropped rather than offered as an install choice, and a README over 256 kB is truncated. Loading details also seeds the `latest` cache, so the home row and the package page agree without a second request; a cold `latest` read fetches the one-version manifest `<registry>/<name>/latest` instead of the packument. An injected `fetchImpl` neither reads nor writes any cache, so a test cannot leave data behind for another.
- Only the fields an install depends on are typed in `PackumentSchema`; decorative metadata (`description`, `readme`, `keywords`, `maintainers`) is `Unknown` and filtered, so an odd shape there can never make a package impossible to resolve.
- The dependency resolver (`server/publish/runtime/dependencyResolver.ts`) reads through the same client but always fresh (`getInstallPackument`, npm's abbreviated install document: dist-tags and tarballs without README or `time`), so it sees a version the moment it is published even while the browsing cache still shows the previous one. It resolves at most five packages at a time and reports every failure in one message, so a thirty-dependency manifest neither opens thirty simultaneous downloads nor needs one attempt per bad name. `dependencyCache.ts` exports `NPM_CONFIG_REGISTRY` to `bun install` when a non-default registry is configured.
- Upstream timeouts cover the body read too: a registry that sends headers and then stalls yields a 504 instead of pinning the single-flight key.

---

## The install cache

`server/publish/runtime/dependencyCache.ts` owns the on-disk cache and is the only writer. Publish, preview, branch preview, bundle import and the resolve route all go through `ensureRuntimeDependencyCache(lock)`.

- **Layout:** `<cacheRoot>/deps/<hash>/` holds a generated `package.json`, `node_modules/` and the marker `.instatic-install-complete`. `<hash>` is `runtimeDependencyLockHash(lock)` (names and exact versions only), so the same lock always lands in the same slot and the URLs under `/_instatic/runtime/cache/<hash>/` are immutable.
- **Location:** `cacheRootDir()` returns `readRuntimeCacheDir()` from `server/config.ts`: `RUNTIME_CACHE_DIR` when set, otherwise `runtime-cache/` in the instance state directory (`instanceStateDir` in `server/instanceDir.ts`, the same rule the Manager API directory follows). That is beside the SQLite database, or beside `UPLOADS_DIR` for Postgres, so it is on the volume that already holds the site's data in the Railway, Render and desktop layouts; `compose.prod.yml` sets it to `/app/data/runtime-cache` on the `data` volume. It is never inside `UPLOADS_DIR`, which is served at `/uploads/*` and copied by Manager API transfers; the server warns at boot when an override puts it there. The cache needs no backup.
- **Install is atomic:** `bun install --ignore-scripts` runs in a `.tmp-<hash>-<pid>-<random>` sibling, the marker is written inside it, and the directory is renamed into the hash slot. An install that exits 0 without every locked package on disk fails with the missing names and leaves no entry.
- **An entry is trusted only when it is intact:** `isRuntimeDependencyCacheIntact(lock)` requires a readable marker, a `package.json` under `node_modules/` for every locked package, and the entry file each package serves. The marker alone is not enough, because a temp cleaner removes the installed files and leaves the directories and the marker. `package.json` alone is not enough either: the importmap builder reads it on every build, so a cleaner that ages files out by access time removes `dist/index.js` long before it. At install the marker records each package's served entry (`entries`, resolved by `resolveInstalledPackageEntry`, the same resolver the importmap builder uses), so the check is one small read plus `existsSync` calls, with no manifest parsing. A package whose resolved entry does not exist after install (a CSS-only package, for one) is left out of `entries` rather than failing the install. An entry that fails the check, including one whose marker predates `entries`, is replaced by a fresh install through the same rename.
- **Single-flight:** concurrent calls for one hash share one install promise (`inFlightInstalls`), including the reinstall of a broken entry.
- **A lost entry is restored on the first request for it:** published pages keep pointing at `/_instatic/runtime/cache/<hash>/` for as long as they are live, and nothing reinstalls on boot. When `packageServer.ts` finds the marker or the requested file missing, it calls `restorePublishedRuntimeCache(db, hash)` (`publishedCacheRestore.ts`). That traces the hash to a publish that is live now, confirms the snapshot's lock hashes to it, and runs `ensureRuntimeDependencyCache(lock)`. The live hashes come from one index per publish version: `listLivePublishedImportmaps` reads the importmap of every live snapshot once, the hashes in those URLs are kept in memory, and `bumpPublishVersion` invalidates it. The snapshot's lock is read only for a hash in that index. This covers a recreated container without a volume for the cache, a database restored onto a fresh disk, and the upgrade that moved the default out of the temp folder. A hash no live publish uses is a 404 answered from memory: it does not touch the database and installs nothing, so a public URL cannot trigger a table scan per request. A failed reinstall is remembered on the live hash's index entry for 30 seconds, so repeated requests do not repeat the install, and requests for other hashes cannot evict that backoff. A file that is present is served without touching the database.

---

## Forbidden patterns

- **Putting the cache where the OS or a redeploy deletes it, or inside `UPLOADS_DIR`.** The default is persistent on purpose; the restore above is the safety net, not the plan, because the visitor who triggers it waits for a `bun install` and the server needs the registry at that moment.
- **Trusting a cache entry because its marker exists.** Ask `isRuntimeDependencyCacheIntact(lock)` or call `ensureRuntimeDependencyCache(lock)`; `existsSync(sentinelPathForHash(...))` says the install once finished, not that the files are still there.

- **Talking to a registry from the browser.** The panel only calls `/admin/api/cms/registry/*`; the registry host, credentials and caching live on the server. A `fetch('https://registry.npmjs.org…')` in `src/admin` bypasses `NPM_REGISTRY_URL` and the boundary validation.
- **Reading a package for install from the browsing cache.** `getInstallPackument` is uncached on purpose; only `getPackageDetails` (a projection) is cached. Caching packuments reintroduces stale installs and multi-megabyte cache entries.
- **Building a registry URL from an unvalidated name.** Every handler and client entry runs `isSafePackageName` first; the route regex only captures the segment, it does not validate it.
- **Rendering README HTML without `MARKDOWN_DOCUMENT_CONFIG`.** The richtext config strips images and tables; the plain publisher output is unsanitised. `readmeHtml.ts` is the one place both steps meet. The profile carries `_externalImagesOnly`, which is what makes the sanitizer's attribute hook drop non-http image sources; the hook does nothing to images under any other profile. The profile also drops `id` and `class` from the richtext attribute set: a README is third-party markup rendered inside the admin, and an attacker-chosen `id` would collide with the app's own elements.
- **A second `useInstalledDependencies()` per view.** It walks every script and page; `RegistryPanel` calls it once and passes the result down.
- **Deciding "public npm" per response.** The panel reads it once from the profile route; `RegistryPackageDetails` carries no registry flag.

## Tests

- `src/core/registry/__tests__/esmEntry.test.ts` — entry rules, description cleaning.
- `server/registry/__tests__/client.test.ts`, `cache.test.ts` — URL building, public-only qualifiers, sort weights, mapping, loose metadata, abbreviated documents, dangling dist-tags, README truncation, caller-abort, cache bypass under an injected fetch, 404 / timeout / shape errors, TTL sweep + single-flight, profile.
- `server/handlers/cms/__tests__/registry.test.ts` — auth floor, profile, query validation, scoped names, upstream error mapping, 405.
- `src/__tests__/panels/dependenciesPanel.test.tsx` — installed rows, runtime issues, resolve status, search → detail → install, latest-first version default, paging reset, removal (confirm dialog, and without the registry), declaring a package the registry cannot describe, a failed registry profile, prototype-named packages, capability gating (install, remove and resolve).
- `src/__tests__/server/runtimeDependencies.test.ts`, `server/publish/runtime/__tests__/cacheLayout.test.ts` — lock resolution, the install workspace, the marker, reinstall of an unfinished or hollowed-out entry (including one that kept `package.json` but lost its entry file), single-flight, the package cap and timeout, and that writer and readers agree on the cache paths.
- `server/publish/runtime/__tests__/publishedCacheRestore.test.ts`, `src/__tests__/server/serverConfig.test.ts` — a live publish's package URL answers again after the cache directory or its files are lost, unknown and replaced hashes install nothing and unknown ones cost no query after the index is read, failed reinstalls are not retried per request even while other hashes are requested, and where the default cache directory lands for SQLite and Postgres.
- `tests/e2e/runtime-dependencies.e2e.ts` (SITE-014) — the live browser path, including browsing the registry and installing from a package page, and deleting the server's cache folder after publish to check the package URL still answers.
- `src/__tests__/core/markdownDocumentSanitize.test.ts` — what a README may and may not render, and that the image policy is profile-scoped.

## Related

- [`site-shell.md`](site-shell.md) — `SitePackageJson`, `SiteRuntimeConfig`, the dependency lock and the importmap the publisher emits.
- [`publisher.md`](publisher.md) — how locked packages are served from `/_instatic/runtime/cache/<hash>/`.
- [`auth-and-access.md`](auth-and-access.md) — the `site.read` / `runtime.dependencies` capabilities.
- [`../server.md`](../server.md) — CMS route dispatch and the boot-time config that sets the registry URL.
- [`../design.md`](../design.md) — the tile-card pattern the panel is built on.

Source-of-truth files: `src/core/registry/schemas.ts`, `src/core/registry/esmEntry.ts`, `server/registry/client.ts`, `server/registry/config.ts`, `server/handlers/cms/registry.ts`, `src/core/persistence/cmsRegistry.ts`, `src/admin/pages/site/panels/DependenciesPanel/RegistryPanel.tsx`, `src/admin/pages/site/panels/DependenciesPanel/useInstalledDependencies.ts`.

Gate tests: `src/__tests__/architecture/no-core-barrel-deep-imports.test.ts` (`@core/registry` is a gated barrel), `src/__tests__/architecture/boundary-validation.test.ts`, `src/__tests__/architecture/no-native-title-tooltips.test.ts`, `src/__tests__/store/selectorStability.test.ts`.
