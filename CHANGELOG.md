# Changelog

All notable changes to Instatic will be documented here.

This project is pre-1.0. Breaking changes may appear in minor or patch releases until a stable release line exists.

## Unreleased

## 0.0.4 - 2026-06-13

### Editor & canvas

- Inline text editing on the canvas — double-click any text node to edit it in place, byte-identical to the published element.
- User-saved layouts: save any subtree and re-insert it exactly elsewhere.
- Double-click a row in the explorer / DOM panels to rename it.
- Design mode now opens at 50% zoom; live mode is pinned to 100%.
- Live mode shows the shared frame skeleton while hydrating, and the template read-only hint/open action is scoped to template chrome rather than page content.
- Removed inconsistent panel keyboard shortcuts from the rail.
- Fixed template-preview fidelity: composed read-only content (template chrome, outlet previews, inlined Visual Components) now carries each node's inline styles, matching the published page.

### Publisher & media

- `<img sizes>` is now derived automatically from the layout — the manual Sizes field is gone, and lazy images use the standards-based `sizes=auto` with a layout-resolved fallback.
- Responsive images never serve multi-MB originals to retina screens: `srcset` is built from variants only.
- Single class-CSS emission engine shared by publish and canvas, and one-way publisher layering (repositories never import the publish layer).
- Per-module published-JS channel; the form runtime now rides it.

### Templates & content

- Added a "Not found" template target for designing 404 pages.
- Content Outlet availability fixes and toast layering; closed outlet invariant holes.
- Roster saves now survive slug handoffs (homepage swap, swaps, revivals).

### Site import

- Refactored the Super Import pipeline into one adapter contract with a phase-decomposed plan/commit flow and deduped helpers; conflict resolution split into named concerns.
- Improved import fidelity: rgba color tokens, import-from-anywhere, and engine-proof `var()` / `env()` declarations at the import boundary.

### AI & plugins

- AI tools now inherit the caller's capabilities — `ai.chat` no longer acts as a blanket read grant, and write tools require `ai.tools.write`.
- AI credential auth is derived from the provider.
- Plugin performance: handle-based VM dispatch, native base64, and indexed content-API lookups; fixed `useCanvasNodeRect` to measure real canvas nodes.

### Admin & performance

- Unknown admin URLs (typos, stale deep links, `/admin/login`) now redirect to the dashboard — showing the login form when signed out — instead of rendering a blank page. Public-site 404s keep their own handling.
- Incremental site saves with runtime builds hoisted out of the publish transaction, plus hot-path fixes across the publish pipeline, public serving, and the editor store.
- Dead-code cleanup across the codebase (knip reports zero unused surface).

### Infrastructure

- Standardized container images on GHCR and dropped the Docker Hub mirror.

## 0.0.3 - 2026-06-10

- Hardened the plugin QuickJS sandbox against hangs: interrupt deadlines on plugin-source and timer execution, a host-side worker RPC timeout, and preserved VM stack traces in server logs.
- Made plugin `fetch` and plugin HTTP routes binary-safe end to end (byte-exact request/response bodies, including multipart uploads).
- Plugin settings saved in the admin UI (or via `settings.replace`) now propagate to the running plugin VM immediately, without a reload.
- Fixed plugin scheduler correctness: schedule cancellation, pause persistence across restarts, no firing for disabled plugins, and a sweep for orphaned schedules.
- Plugin-emitted hook events are now namespaced to `plugin.<id>.*`, so a plugin can no longer forge core or other plugins' events.
- Required a dedicated `editor.code` permission for unsandboxed admin-window plugin code, and the install review dialog now always shows.
- Secret plugin settings are masked on every client-facing payload and encrypted at rest in a dedicated `plugin_secrets` table using `INSTATIC_SECRET_KEY`.
- Added a force-uninstall escape hatch for plugins with failing lifecycle hooks, and run `deactivate` before `uninstall`.
- Decoupled the CSRF origin check from proxy trust: it now uses `PUBLIC_ORIGIN` (auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` on managed platforms), and `TRUSTED_PROXY_CIDRS` is now used only for client-IP attribution. Removed blanket `0.0.0.0/0` proxy trust from the deploy templates.
- Refreshed deployment docs and one-click templates (`TRUSTED_PROXY_CIDRS`, `PUBLIC_ORIGIN`, `RAILWAY_RUN_UID`, template-generated `INSTATIC_SECRET_KEY`).
- Fixed the data-table step-up authentication flow and revamped the README.

## 0.0.2 - 2026-06-09

- Added public repository community files and contribution workflow docs.
- Tightened forwarded-origin handling so `X-Forwarded-Proto` and `X-Forwarded-Host` are trusted only from configured proxy peers.
- Added Render deployment blueprints and refreshed public deployment docs.
- Improved static site import fidelity, including imported runtime behavior and CSS cascade isolation.
- Added editable HTML attributes and path-derived Site Explorer organization.
- Hardened plugin media handling, public forms, AI credential storage, and MFA secret encryption.

## 0.0.1 - 2026-06-08

- First public preview release.
- Self-hosted Bun CMS server with SQLite and Postgres support.
- React admin UI with visual site editor, content/data/media workspaces, publishing pipeline, and plugin runtime.
- Docker image, Compose files, release bundle, and Railway/Render/VPS deployment docs.
