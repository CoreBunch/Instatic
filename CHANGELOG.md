# Changelog

All notable changes to Instatic will be documented here.

This project is pre-1.0. Breaking changes may appear in minor or patch releases until a stable release line exists.

## Unreleased

## 0.0.7 - 2026-06-29

### AI & integrations

- Added MCP connectors so external AI clients can use the CMS tool surface through scoped connector tokens.

### Design and onboarding

- Imported Core Framework defaults from onboarding so new sites start with the selected design system values in place.

### Security

- Hardened sanitizers and regular expressions flagged by CodeQL.

### Documentation and deployment

- Replaced the README hero screenshot with a YouTube-linked introductory video thumbnail.
- Added README guidance explaining that image-based installs update by redeploying the latest image.

## 0.0.6 - 2026-06-26

### AI & agent tooling

- Added runtime code asset tools for agents so generated or edited runtime assets can be managed through the same agent workflow.

### Site import, export, and transfer

- Fixed site export downloads in environments where blob-backed responses were unreliable.
- Streamed site transfer bundles and unified the import review flow around the transfer archive path.
- Reused the CMS media client across site import code paths.

### Templates, content, and publishing

- Fixed dynamic data resolution inside outlet previews.
- Stopped auto-creating post type templates; entry templates are now explicit pages users create and assign.
- Hid the empty content settings panel until an entry is selected.

### Editor and admin

- Split non-site workspace layout state from the site editor layout.
- Fixed Spotlight layer commands to operate on the active canvas tree.
- Removed circular admin dependencies and restored lazy HMR loading.
- Simplified admin color token vocabulary and added fluid typography and spacing token scales.

### Quality

- Reused page-tree traversal selectors in form analysis.
- Expanded feature validation coverage across the admin, server, and architecture gates.

## 0.0.5 - 2026-06-17

### AI & agent tooling

- Added document-targeted site agent tools for pages, templates, and Visual Components: `list_documents`, `read_document`, and `open_document` replace the page-only read surface.
- Loop authoring now routes through the HTML import path and gives agents valid loop-source field tokens before they bind dynamic content.

### Content, data, and export

- Split system-table and custom-table capabilities, and locked system table identity while still allowing safe custom field edits.
- Routed collection create, update, and delete through step-up authentication.
- Added a granular full-site export dialog with Cmd+K access and server-accurate export size estimates, including media.
- Fixed Content Outlet rendering so current-entry bodies render in any content outlet.

### Editor and canvas

- Made the Settings modal and toolbar trailer global instead of editor-panel scoped.
- Made saved layouts the single source of truth.
- Rendered `base.text` with `tag: none` as bare text on canvas to match the published DOM.
- Rewrote the GitHub README with deeper product and self-hosting detail.

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
