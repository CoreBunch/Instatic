# Changelog

All notable changes to Instatic will be documented here.

This project is pre-1.0. Breaking changes may appear in minor or patch releases until a stable release line exists.

## Unreleased

## 0.0.11 - 2026-07-11

### AI and integrations

- Added multi-image AI conversations with paste and picker flows, compact galleries and previews, private history persistence, model capability checks, and optional Save to Media actions.
- Added a compact context meter with remaining-context, token, cache, cost, and model-pricing details.
- Made render snapshots faithfully capture authored backgrounds and breakpoint-specific layouts without changing the visible canvas state.
- Expanded `site_apply_css` with explicit merge, replace, property-removal, and delete operations, preserved `!important` priorities, and an Anthropic-compatible provider schema.
- Expanded MCP connectors with headless document listing, scoped Site and Content workspace bridges, and explicit capability-gated publishing after saved draft edits.

### Editor, content, and publishing

- Added a light admin theme and UI text-size preferences alongside the existing density setting.
- Added editors for custom content fields, including structured, media, and relation values, directly in the Content settings panel.
- Added middle-mouse canvas panning and improved Layers visibility, scrolling, and empty-container presentation.
- Derived font-weight choices from installed variants, tolerated malformed stored font settings, and fixed stale selection or focus after undo, redo, and assistant-panel interactions.

### Import and publishing

- Imported YouTube iframes and HTML `<video>` elements as native Video modules, preserving playback and accessibility settings.
- Optimized media-library background images into responsive variant fallbacks and `image-set()` output in both the editor and published CSS.
- Made whole-site saves transactional with explicit deletes and a serialized save queue, preventing partial or interleaved saves before publishing.

### Security and data safety

- Hardened custom HTML attributes and tags against stored script injection by rejecting dangerous URL schemes, `srcdoc`, and unsafe embedded elements.
- Applied shared magic-byte, MIME, extension, SVG-sanitization, traversal, and reserved-path validation to JSON and archive media imports.
- Added `base-uri 'self'` and `object-src 'none'` to the admin Content Security Policy.

### Platform and reliability

- Fixed Postgres JSON text-column hydration and made static publish-slot swaps reliable on Windows.
- Made Windows development startup use the active Bun runtime with safer Vite launching and stale-port recovery.
- Recovered interrupted AI browser-tool turns as terminal, retryable failures instead of leaving conversations stuck or replaying malformed history.
- Cleaned up disconnected MCP, editor, and plugin streams and bounded orphaned connection lifetimes so abandoned connections cannot exhaust the development proxy.

## 0.0.10 - 2026-07-01

### AI and integrations

- Added an OpenAI-compatible AI provider for custom base URL endpoints.

### Import, editor, and publishing

- Fixed imported module scripts so their npm dependencies install correctly.
- Aligned canvas and Layers panel keyboard shortcuts.
- Let modules declare Content Security Policy sources, so published `base.video` YouTube embeds render correctly.
- Fixed empty-folder explorer operations so they apply without showing the "0 paths" dialog.

## 0.0.9 - 2026-07-01

### AI and integrations

- Redesigned the AI assistant panel message stream: agent tool calls render as compact rows with a per-tool icon, a human-readable label, and status, with consecutive calls grouped under one turn.
- Added inline previews to tool calls — colour-token swatches for palette updates, and the captured screenshot for render-snapshot.
- Auto-titled conversations from the first prompt instead of "New conversation", and gave each message turn an avatar and a relative timestamp.
- Fixed the AI panel dropping the selected model when starting a new chat, and surfaced conversation delete/load failures as toasts.

### Editor and framework

- Added a body context menu when right-clicking empty space on the canvas.

## 0.0.8 - 2026-07-01

### Editor and framework

- Unified Core Framework management into one tabbed panel with a declarative Full / Variables / None manager.
- Consolidated Layers, Site, Code, and Media into one Explorer panel, including a dedicated Code tab and refreshed media browsing.
- Added canvas support for dragging media assets directly from the Media workspace.
- Fixed onboarding framework import defaults and retained pending site reloads so imported framework changes appear in the editor without a hard refresh.
- Fixed canvas mouse-wheel behavior so normal wheel scrolling stays vertical and Shift+wheel pans sideways.
- Kept the highlighted Spotlight result scrolled into view during keyboard navigation.

### AI and integrations

- Made AI token tools more tolerant of model-authored argument aliases for framework typography and spacing updates.

### Security

- Added central security response headers for admin and upload routes.
- Revalidated and sanitized imported archive media, including SVG payloads, before writing them to disk.
- Added expiry timestamps for MCP connector tokens, with existing tokens backfilled to a 90-day grace period.

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
