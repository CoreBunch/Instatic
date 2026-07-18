# Site Artifacts

Site artifacts are the deployment boundary between the private builder workspace and the website a user owns. Publishing still happens inside the CMS, where page trees, content, modules, plugins, and media are available. Deployment receives only the resulting files and a small generic HTTP runtime.

---

## TL;DR

- Every full publish writes `/.instatic/site-artifact.json` into the active atomic publish slot.
- `bun run site:export` materializes the active artifact as `site-deploy/`.
- The export contains `public/`, `runtime.ts`, `Dockerfile`, and `railway.json` only.
- `site-runtime/runtime.ts` imports only `node:path`; it has no CMS, database, auth, admin, AI, or plugin-host dependency.
- Local media and self-hosted font files are copied into the artifact during export.
- Dynamic holes, infinite loops, CMS-native forms, proxied media, plugin-hosted frontend assets, and plugin public routes make an artifact non-portable in the first version. Export fails clearly unless `--allow-incomplete` is supplied for diagnostics.

---

## Boundary

```text
Builder workspace
  page trees + content + media + plugins + AI
                    |
                    | publish
                    v
Versioned site artifact
  HTML + CSS + browser JS + media + manifest
                    |
                    | export / deploy
                    v
Website runtime
  generic file server, no builder code or database
```

The artifact is a product output, not a copy of the project repository. Users can inspect, archive, move, and host it independently. The builder implementation remains outside the deployment context.

---

## Manifest

`src/core/site-artifact/schema.ts` owns manifest schema version `1`. The manifest records:

- the artifact and minimum runtime schema versions;
- publish identity and timestamp;
- every public route and its exact HTML file;
- uploaded media and font files that must be copied;
- portability status and machine-readable requirements.

Routes have one of three kinds: `page`, `content`, or `notFound`. The runtime never guesses URL rewrites from the filesystem; it serves the route table from the manifest.

---

## Publish Contents

A full publish writes the following into the inactive slot before the atomic pointer swap (a symlink on POSIX and a marker file on Windows):

- complete HTML documents for pages, content rows, and the designed 404;
- hashed site and page CSS bundles;
- page runtime JavaScript;
- module runtime JavaScript;
- hole and loop runtimes when referenced;
- a reference to the dependency cache used by published browser modules;
- `/.instatic/site-artifact.json` last, after the artifact is complete.

The active slot remains usable by the combined CMS server without duplicating its package cache on every publish. Export copies the slot into a standalone deployment directory, materializes any referenced runtime packages, and adds local media plus the generic runtime shell.

---

## Portability

Version 1 supports fully pre-rendered sites. These requirements currently need the full builder server and therefore block a normal export:

| Requirement | Why it is not standalone yet |
|---|---|
| Dynamic holes | They call `/_instatic/hole/*` and need snapshot rendering plus data access. |
| Infinite loops | They call `/_instatic/loop/*` for later pages. |
| CMS-native forms | They submit to the CMS form handler and storage. |
| Proxied media | The source is fetched through the builder's media proxy. |
| Plugin frontend assets | Their files still live inside the installed plugin directory. |
| Plugin public routes | Their handlers execute in the builder's plugin sandbox. |

This is deliberate capability negotiation rather than a silent broken deploy. Later artifact/runtime schema versions can add isolated public functions without exposing the builder.

---

## Export And Deploy

Run a full publish, then materialize the active slot:

```sh
bun run site:export
```

Useful options:

```sh
bun run site:export --output my-site
bun run site:export --uploads-dir ./uploads
bun run site:export --allow-incomplete
```

The output is a complete Docker build context:

```text
site-deploy/
├── Dockerfile
├── railway.json
├── runtime.ts
└── public/
```

Build and run it locally with:

```sh
docker build -t my-site ./site-deploy
docker run --rm -p 3000:3000 my-site
```

For Railway, deploy `site-deploy/` as the service root. It needs no database and no persistent volume because each artifact image is immutable.

---

## Runtime Contract

The standalone runtime provides:

- manifest-driven page and content routes;
- exact static asset and copied-media paths;
- `GET` and `HEAD` support;
- byte ranges for media;
- cache headers for immutable assets and revalidated HTML;
- `/health` for platform health checks;
- the published 404 page;
- explicit `501` responses for unsupported dynamic Instatic endpoints.

It refuses private manifest and admin paths. Files are resolved inside `public/`, and path traversal is rejected.

---

## Invariants And Tests

- `src/__tests__/architecture/site-runtime-isolation.test.ts` gates runtime imports and Docker context.
- `server/publish/siteArtifact.test.ts` covers manifest generation, requirement detection, media collection, route mapping, and materialization.
- `site-runtime/runtime.test.ts` covers public routing, private-path denial, health, unsupported dynamic endpoints, and byte ranges.

The runtime is intentionally generic. Product-specific behavior belongs in the artifact contract or in future isolated public-function bundles, never by importing builder internals.

## Related

- [publisher.md](publisher.md) — rendering and full-publish pipeline
- [../architecture.md](../architecture.md) — system boundaries
- [../deployment/railway.md](../deployment/railway.md) — Railway deployment modes
- `server/publish/siteArtifact.ts` — manifest creation and export materialization
- `site-runtime/runtime.ts` — standalone server
