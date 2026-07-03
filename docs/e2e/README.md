# User E2E Testing

This folder defines the agent-run browser testing workflow for Instatic.

- `protocol.md` explains how an agent should run user-facing E2E audits.
- `feature-validation.tsv` is the canonical feature, test, and defect
  spreadsheet for broad quality-loop runs.
- `feature-matrix.md` lists scenario rows by product area.
- `capabilities.md` expands the capability/access-control E2E rows.
- `run-log-template.md` is copied into `runs/` for each audit.
- `runs/` stores completed run logs.

## Common Requests

Use these prompts with Codex:

- "Run the Core Owner Lifecycle E2E protocol."
- "Run rows MEDIA-001 through MEDIA-003."
- "Run a friction audit of the visual builder."
- "Run the capability E2E scenarios."
- "Retest E2E-20260514-01 from the last run."
- "Promote PUB-001 into automated smoke coverage."

The project-local `instatic-user-e2e` skill should load for those requests and keep the agent focused on browser-observed user behavior.

## Automated Playwright E2E

The scripted regression suite lives outside this folder in `tests/e2e/`.
Automated E2E files use the `*.e2e.ts` suffix so `bun test` does not load
Playwright specs as unit tests.
It complements the agent-run audits above; it does not replace them. Use
Playwright for stable, critical flows where the expected result is
unambiguous, and keep exploratory UX, accessibility, and visual-friction work
in the agent-run protocol.

Run the automated suite with:

```sh
bun run test:e2e:install
bun run test:e2e
```

The Playwright config starts a disposable local stack by default:

- Admin UI: `http://127.0.0.1:5174`
- CMS/public site: `http://127.0.0.1:3002`
- Database: `.tmp/e2e-agent.db`
- Uploads: `.tmp/e2e-uploads`

`scripts/e2e-dev.ts` resets only those `.tmp/e2e-*` paths, then runs the same
Vite + Bun CMS stack a developer uses — with one deliberate difference: the CMS
runs **without** `bun --watch`. A regression suite needs a stable server, and
under watch the publish pipeline writing baked HTML (and the SQLite DB churning)
can reload the server mid-test and drop in-memory state. Vite is likewise told to
ignore the runtime-written paths (`.tmp`, `uploads`, `dist` in `vite.config.ts`),
so publishing never reloads the admin app mid-test. The Vite dev proxy follows
the configured CMS `PORT`, keeping the Playwright admin UI pointed at the
disposable CMS instead of any regular dev server on port 3001.

For debugging against a server you started yourself, set
`E2E_REUSE_SERVER=1` and override `E2E_ADMIN_BASE_URL` /
`E2E_PUBLIC_BASE_URL` as needed. Do not use reuse mode for CI or for
regression runs that need a clean database.

### Suite structure

- **`tests/e2e/helpers/`** — small, user-behaviour-shaped helpers (setup/login,
  open editor, save draft, publish-with-step-up, insert module, create page,
  visit a public page in a fresh context). No large abstractions.
- **`auth.setup.ts`** — a Playwright *setup project* that runs once. The
  disposable DB is set up once per run, so first-run setup happens here (proving
  SETUP-001) and the owner's authenticated `storageState` is saved. Every spec
  depends on it.
- **Session rule.** Specs default to the shared owner `storageState` (fast).
  Specs that run a **step-up-gated action** (publish, profile basics, etc.) or
  **sign out** rotate the session token server-side, so they opt into
  `ANONYMOUS_STATE` and `login()` fresh — otherwise they would invalidate the
  shared state for later specs.
- **Selectors.** Durable user-facing selectors first (roles, labels, accessible
  names). `data-testid` only for stable editor/canvas controls where an
  accessible name is not practical (canvas notch, toolbar publish actions, the
  step-up dialog).
- **Isolation.** With `workers: 1` all specs share one database; each spec works
  on its own uniquely-named page/post (only the core lifecycle spec edits the
  homepage), and publish→assert happens within a single test so cross-spec order
  never matters.

### Automated coverage map

These feature-matrix rows now have automated regression coverage. Rows list
Playwright specs unless a focused Bun test path is included:

| Row(s) | Spec |
|---|---|
| SETUP-001 | `auth.setup.ts` |
| AUTH-001, EDIT-001, SAVE-001 (desktop core lifecycle + mobile reload), PUB-001, PUB-002, PUB-003 | `core-owner-lifecycle.e2e.ts`, `page-management.e2e.ts` |
| PUBLISH-002 (active page scheduling + due-row scheduler tick) | `page-management.e2e.ts`, `src/__tests__/server/publishScheduler.test.ts` |
| AUTH-003 (logout + stale-tab session revocation + stale-route console guard + repeated stale logout + mobile account menu) | `auth.e2e.ts`, `src/__tests__/admin/accountMenuButton.test.tsx`, `src/__tests__/server/authSessionEdgeCases.test.ts`, `src/__tests__/server/cmsHandlers.test.ts`, `src/__tests__/toolbar/moduleInserterPreference.test.tsx` |
| CAP-003 (publish + user-create desktop/mobile/MFA/expired-window + plugin install/uninstall + destructive import + secondary API step-up) | `core-owner-lifecycle.e2e.ts`, publishing specs, `users.e2e.ts`, `account.e2e.ts`, `capabilities.e2e.ts`, `src/__tests__/server/stepUpSecondaryActions.test.ts` |
| ADMIN-001 | `admin-navigation.e2e.ts` |
| DASH-001, DASH-002, DASH-003 | `dashboard.e2e.ts`, `page-management.e2e.ts` |
| PAGE-001, PAGE-002, PAGE-003, PAGE-004 | `page-management.e2e.ts` |
| BUILDER-001, BUILDER-002, BUILDER-005, BUILDER-007, EDIT-002, SITE-005 (desktop keyboard + picker drag/drop + 390px picker), SITE-009, SITE-017, SITE-018, SITE-019 | `visual-builder.e2e.ts`, `src/__tests__/toolbar/moduleInserterModel.test.ts`, `src/__tests__/toolbar/moduleInserterFavorites.test.tsx`, `src/__tests__/toolbar/moduleInserterPreference.test.tsx`, `src/__tests__/toolbar/modulePickerDropdown.test.tsx`, `src/__tests__/editor-store/pageActionsSelection.test.ts` |
| BUILDER-008 (rich-body formatting persistence + public render) | `content.e2e.ts` |
| MEDIA-001, MEDIA-002, MEDIA-003, MEDIA-004 (viewer metadata + mobile viewer), MEDIA-005 (replace/delete/restore/purge + mobile lifecycle), MEDIA-006 (built-in storage panel + mobile panel), MEDIA-007 (SVG sanitizer/public media) | `media.e2e.ts` |
| CONTENT-001, CONTENT-002, CONTENT-003, CONTENT-005, CONTENT-006, CONTENT-007 | `content.e2e.ts` |
| SPOT-001, SPOT-002, SPOT-003, SPOT-004, SPOT-005, SPOT-006, SPOT-007, SPOT-008, SPOT-009, SPOT-010, SPOT-011, SPOT-012, SPOT-013 | `command-palette.e2e.ts` |
| ADMIN-004, USERS-002 (role lifecycle + mobile layout + API edge semantics), USERS-003 (audit feed, mobile table, and API/UI edge semantics), CAP-001 (desktop isolation + mobile limited navigation) | `users.e2e.ts`, `src/__tests__/server/roleManagementEdges.test.ts`, `src/__tests__/server/auditLogEdges.test.ts`, `src/__tests__/users/auditFormat.test.ts`, `src/__tests__/users/usersAdmin.test.tsx` |
| CAP-002 | `capabilities.e2e.ts` |
| CAP-004 (data/media affordance splits) | `capabilities.e2e.ts` |
| CAP-005 (plugin read/install/configure/lifecycle/schedule/pack + AI chat rail + provider/audit tab gates + AI write-tool filtering) | `capabilities.e2e.ts`, `ai.e2e.ts` |
| ADMIN-002 (profile basics), ACCOUNT-001 (display name + profile API edges + mobile cancel/no-op), ACCOUNT-002 (avatar upload/removal/invalid upload feedback/API edges/storage error/mobile layout), ADMIN-003 (MFA setup cancel), ACCOUNT-003 (password change + mobile dialog), AUTH-002 (MFA TOTP/mobile challenge/pending-session API edges/unknown-cookie rejection/empty+wrong-code feedback/recovery-code login/reuse rejection), AUTH-004 (active-device sign-out + mobile table + session API edges), ACCOUNT-004 (MFA invalid-code feedback, QR fallback, enable/login/recovery regenerate/disable + mobile setup/login containment), ACCOUNT-005 (step-up window + mobile controls + disabled/invalid API edges), AUTH-006 (failed/successful login activity feed, disposable-account lockout/rate-limit browser flow, and suspicious activity banner) | `account.e2e.ts`, `src/__tests__/admin/accountPage.test.tsx`, `src/__tests__/server/accountSecurity.test.ts`, `src/__tests__/server/authSessions.test.ts`, `src/__tests__/server/authSessionEdgeCases.test.ts` |
| PLUGIN-001 (ZIP package install via packaged fixtures), PLUGIN-002 (enable/disable/remove lifecycle), PLUGIN-003 (settings/secrets), PLUGIN-004 (packaged admin pages/resources/runtime route), PLUGIN-005 (schedules), PLUGIN-006 (pack install/re-sync), PLUGIN-008 (invalid manifest upload recovery) | `plugins.e2e.ts` |
| AI-001 (Ollama credential create/delete + offline default guard), AI-002 (Data-scope default save/reload/clear), AI-003 (Site chat history load/new/delete), AI-004 (fixture-backed Site assistant streaming), AI-005 (browser `read_document` tool-result bridge), AI-006 (Audit tab rollups from streamed usage) | `ai.e2e.ts` |
| A11Y-001, A11Y-002, RESP-001, RESP-002 | `accessibility.e2e.ts` |
| PERF-001, PERF-002 (performance/reliability smokes) | `performance.e2e.ts` |
| REL-001 | `reliability.e2e.ts` |
| REL-002 | `error-handling.e2e.ts` |

### Intentionally left agent-run only

Kept in the agent-run protocol because they are subjective, drag/zoom-physics
dependent, environment-dependent, or need product/role tooling that makes a
durable assertion brittle:

- **CAP-004 remaining capability edge variants** — remaining
  data, plugin, and AI capability depth. Need
  multi-persona role setup and step-up side-effect review better audited than
  asserted. (ADMIN-004, USERS-002 role lifecycle, mobile layout, and edge semantics, CAP-001 desktop isolation and mobile limited navigation, CAP-002, and CAP-004 data/media browse,
  manage, import/export, upload, metadata, replace, and delete affordance splits, MEDIA-004 viewer
  metadata edits, MEDIA-005 replace/delete/restore/purge/mobile lifecycle, MEDIA-006
  built-in storage panel and mobile panel coverage, and MEDIA-007 SVG sanitizer/public media
  serving are now automated in `users.e2e.ts`, `capabilities.e2e.ts`, and
  `media.e2e.ts`; CAP-005 plugin
  read/install/configure/lifecycle/schedule/pack, site AI chat rail, AI provider/audit tab gates, and AI write-tool filtering are also automated. ADMIN-003 MFA
  setup cancel, ACCOUNT-001 display-name update/profile API edges/mobile cancel no-op, ACCOUNT-002 avatar upload/removal/invalid upload feedback/API edges/storage error/mobile layout,
  ACCOUNT-003 password change and mobile dialog coverage, AUTH-002 TOTP/mobile challenge/pending-session API edges/unknown-cookie rejection/empty+wrong-code feedback/recovery-code login and reuse rejection,
  AUTH-004 active-device sign-out, mobile table containment, and session API
  edge cases, ACCOUNT-004 MFA invalid-code feedback, QR fallback,
  enable/login/recovery regenerate/disable and mobile setup dialog,
  ACCOUNT-005 step-up window, mobile controls, disabled-mode bypass, and invalid policy values, and
  CAP-003 mobile user-create dialog, expired-window re-prompt, MFA user-create step-up, plus plugin JSON-manifest install/uninstall and
  destructive CMS-bundle replace import step-up are automated too. USERS-003
  mobile audit-table containment is automated in `users.e2e.ts`.)
- **BUILDER-004 remaining edge cases and BUILDER-008 remaining formatted-content edges** —
  drag physics, custom binding/sanitization edges, and visual/typographic
  judgement; left to the friction audit or lower-level tests.
  (BUILDER-003 DOM reorder, BUILDER-004 direct canvas drag, BUILDER-005/SITE-009
  undo/redo history lifecycle, BUILDER-006 style controls, and BUILDER-007 breakpoint variants
  are automated in `visual-builder.e2e.ts`. BUILDER-008 rich-body bold/italic
  persistence and public entry-template rendering are automated in
  `content.e2e.ts`.)
- **MODULE-001 remaining browser/editor permutations** — body/container/outlet
  render contracts are covered by focused Bun tests in
  `src/__tests__/base-modules.test.ts` and
  `src/modules/base/outlet/__tests__/outlet.render.test.ts`; browser insertion,
  full template composition, permission variants, and responsive authored-layout
  review remain agent-run.
- **MODULE-002 remaining browser/editor permutations** — common text/list/link,
  button/image/SVG/video render contracts are covered by focused Bun tests in
  `src/__tests__/base-modules.test.ts`, `src/__tests__/core/sanitizeSvg.test.ts`,
  and `src/__tests__/htmlImport/svgMapping.test.ts`; browser insertion/edit,
  media-picker combinations, permission variants, and responsive authored-layout
  review remain agent-run.
- **MODULE-003 remaining browser/editor permutations** — loop module
  conformance/defaults/tag fallback, publisher iteration/currentEntry and
  parentEntry isolation, empty/missing data, prefetch, infinite runtime
  injection, and request-dependent detection are covered by focused Bun tests in
  `src/__tests__/base-modules.test.ts`,
  `src/__tests__/publisher/loopRender.test.ts`,
  `src/__tests__/server/loopPrefetch.test.ts`, and
  `src/__tests__/server/dynamicDetection.test.ts`; browser insertion,
  dynamic property-panel editing, permission variants, stale-data UX, and
  responsive repeated-layout review remain agent-run.
- **MODULE-004 remaining browser/editor permutations** — form module
  conformance, semantic render contracts, publisher-boundary escaping, formId
  normalization, snapshots, settings analysis, validation, canvas suppression,
  form preview, runtime emission, public endpoint security, and the form
  settings panel are covered by focused Bun tests in `src/__tests__/forms/`,
  `src/__tests__/canvas/`, `src/__tests__/publisher/`,
  `src/__tests__/server/publicForms.test.ts`, and
  `src/__tests__/panels/formSettingsPanel.test.tsx`; browser insertion, full
  edit/save/publish/public submission, permission variants, and mobile form
  composition remain agent-run.
- **MODULE-005 remaining browser/editor permutations** — component-ref,
  slot-outlet, and slot-instance module contracts; publish-behavior dispatch;
  schema-derived defaults; publisher inlining; prop overrides; slot
  content/defaults; missing components; hidden nodes; sanitization; nested refs;
  slot sync; recursion/data-layer gates; editor-store reconciliation;
  persistence healing; canvas slot reactivity/editing; locked slot DnD; and
  placement architecture are covered by focused Bun tests in
  `src/__tests__/base-modules.test.ts`,
  `src/__tests__/module-engine/moduleConsolidation.test.ts`,
  `src/__tests__/publisher/`, `src/__tests__/core/`,
  `src/__tests__/editor-store/`, `src/__tests__/persistence/`,
  `src/__tests__/integration/`, `src/__tests__/canvas/`,
  `src/__tests__/dom-panel/`, and `src/__tests__/architecture/`; browser
  conversion/reuse/publish permutations, permission variants, and mobile
  component editing remain agent-run.
- **SITE-014 remaining browser/operator permutations** — dependency panel
  import analysis, missing-dependency add, stale-lock status, manual and
  background resolve flows, client envelope validation, runtime handler
  normalization, module dependency/importmap filtering, site runtime build,
  dependency resolver/cache, package importmap/server, malformed runtime-cache
  paths, and runtime asset publish injection are covered by focused Bun tests in
  `src/__tests__/panels/depsSectionRuntime.test.tsx`,
  `src/__tests__/editor-hooks/useAutoResolveDependencies.test.tsx`,
  `src/__tests__/persistence/cmsRuntimeClient.test.ts`,
  `src/__tests__/server/cmsRuntimeHandlers.test.ts`,
  `src/__tests__/module-engine/moduleDependencies.test.ts`,
  `src/__tests__/module-engine/runtimeResolver.test.ts`,
  `src/__tests__/server/runtimeDependencies.test.ts`,
  `server/publish/runtime/__tests__/cacheLayout.test.ts`,
  `src/__tests__/server/siteRuntimeBuild.test.ts`,
  `src/__tests__/site-runtime/runtimeConfig.test.ts`,
  `src/__tests__/site-runtime/importAnalysis.test.ts`, and
  `src/__tests__/publisher/runtimeAssets.test.ts`. Browser authoring of a
  site script import, Dependencies-panel missing-package Add, live
  `canvas-confetti` registry/cache resolution, publish, public importmap
  emission, browser loading of the emitted runtime-cache package URL, and a
  390px mobile path that verifies Code Editor authoring plus dependency-panel
  containment/Add reachability are covered by
  `tests/e2e/runtime-dependencies.e2e.ts`; live registry/install failure UX
  permutations remain operator-run.
- **PUBLIC-003 remaining browser/operator permutations** — external CSS link
  generation and stale/malformed CSS 404s, DB-backed and disk-baked runtime
  asset serving, module-JS injection and route validation, runtime package
  importmap/cache/server behavior, full-router ownership of runtime cache
  package URLs, runtime script injection safety, and signed media redirect
  architecture are covered by focused Bun tests in
  `src/__tests__/server/publicRendering.test.ts`,
  `src/__tests__/server/publishStaticArtefact.test.ts`,
  `src/__tests__/server/moduleJsRoute.test.ts`,
  `src/__tests__/server/moduleJsBundle.test.ts`,
  `src/__tests__/publisher/runtimeAssets.test.ts`,
  `src/__tests__/publisher/render.test.ts`,
  `server/publish/runtime/__tests__/cacheLayout.test.ts`,
  `server/__tests__/runtime-bundle-scripts.test.ts`,
  `src/__tests__/server/runtimeAssetRepository.test.ts`,
  `src/__tests__/architecture/module-js-asset-route.test.ts`, and
  `src/__tests__/architecture/media-signed-redirect-serving.test.ts`; browser
  asset waterfalls, CDN cache behavior, real mobile network/device
  permutations, and live signed-storage adapters remain operator-run.
- **PUBLIC-004 remaining browser/operator permutations** — dynamic-node
  detection rules, loop render semantics, loop data prefetch, static-shell
  baking with hole runtime, hole runtime lazy/eager fetching, hole fragment
  stale-version/missing-node/cache behavior, per-query and per-visitor dynamic
  plugin islands, form token stamping in fragments, and full-router ownership
  of hole runtime/fragment URLs are covered by focused Bun tests in
  `src/__tests__/server/holeRouteHandler.test.ts`,
  `src/__tests__/server/holeRuntime.smoke.test.ts`,
  `src/__tests__/server/holePublisher.test.ts`,
  `src/__tests__/publisher/loopRender.test.ts`,
  `src/__tests__/server/loopPrefetch.test.ts`,
  `src/__tests__/server/dynamicDetection.test.ts`,
  `src/__tests__/server/dynamicDetectionLoop.test.ts`,
  `src/__tests__/server/dynamicIslandsPlugin.test.ts`,
  `src/__tests__/architecture/hole-runtime-asset-route.test.ts`, and
  `src/__tests__/server/publishStaticArtefact.test.ts`. Browser route-query
  hole hydration is covered in `tests/e2e/public-dynamic-fragments.e2e.ts`,
  including the baked shell, hole runtime asset, hole fragment response,
  desktop and 390px mobile query values, and public-page overflow guard;
  placeholder-backed real-browser IntersectionObserver timing and live external
  loop-source failures remain operator-run.
- **FORM-001 remaining browser/operator permutations** — form module
  conformance/render contracts, snapshots, settings analysis, compatible field
  binding, setup-panel table creation/missing-field/preview behavior, canvas
  native-control suppression including submit buttons, and form-preview parent
  lookup are covered by focused Bun tests in `src/__tests__/forms/`,
  `src/__tests__/canvas/canvasFormControls.test.tsx`,
  `src/__tests__/canvas/canvasFormPreview.test.ts`, and
  `src/__tests__/panels/formSettingsPanel.test.tsx`; full browser
  authoring-to-publish submission, permission variants, and mobile public form
  layout remain operator-run.
- **FORM-002 remaining browser/operator permutations** — full-router ownership
  of public form URLs, same-origin/page-token challenge issuance, one-time
  challenge submission, oversized payload handling, rate limits, target-table
  guards, field validation, form runtime challenge prefetch/submit delegation,
  page-token stamping, form module contracts, snapshots, settings analysis, and
  settings-panel behavior are covered by focused Bun tests in
  `src/__tests__/server/publicForms.test.ts`,
  `src/__tests__/publisher/formRuntime.test.ts`,
  `src/__tests__/publisher/formModuleJs.test.ts`,
  `src/__tests__/server/formChallengeSecret.test.ts`,
  `src/__tests__/forms/formModules.test.ts`,
  `src/__tests__/forms/formSettingsAnalysis.test.ts`,
  `src/__tests__/forms/formSnapshot.test.ts`,
  `src/__tests__/forms/formValidation.test.ts`, and
  `src/__tests__/panels/formSettingsPanel.test.tsx`; browser success/error
  copy, min-submit timing with real clocks, full authoring-to-publish form
  submission, and mobile public form layout remain operator-run.
- **CONFIG-001 remaining operator permutations** — DATABASE_URL parsing,
  SQLite adapter selection, parent-dir creation, migration idempotence,
  Postgres scheme selection, invalid scheme errors, migration parity, JSON
  column naming, repository SQL portability, SQLite smoke behavior, rowCount,
  transaction serialization, advisory-lock fallback, statement cache, dev
  workflow, and Docker config are covered by focused Bun tests in
  `src/__tests__/db/`, `src/__tests__/architecture/`,
  `server/db/__tests__/`, `src/__tests__/devWorkflow.test.ts`, and
  `src/__tests__/server/dockerConfig.test.ts`; live Postgres connectivity,
  credential failures, backups/restore, and hosted environment permutations
  remain operator-run.
- **CONFIG-002 remaining operator permutations** — runtime config defaults
  and env overrides for `PORT`, `DATABASE_URL`, `UPLOADS_DIR`, `STATIC_DIR`,
  trusted proxies, and public origins; health routing; admin/static/uploads
  serving; upload response hardening; dev launcher/proxy contracts; and
  Docker image/compose healthcheck/persistent-data wiring are covered by
  focused Bun tests in `src/__tests__/server/serverConfig.test.ts`,
  `src/__tests__/server/staticAdmin.test.ts`,
  `src/__tests__/server/router.test.ts`, `src/__tests__/devWorkflow.test.ts`,
  and `src/__tests__/server/dockerConfig.test.ts`; actual port-conflict
  handling, Caddy TLS issuance, filesystem permission failures, and
  deployed-platform smoke remain operator-run.
- **CONFIG-003 remaining operator permutations** — form secret precedence and
  fallback, public form challenge routing, plugin manifest host/path/coherence
  checks, granted-permission enforcement, SSRF-gated fetch, encrypted plugin
  settings, media adapter boundary validation, and runtime dependency
  cache/package serving are covered by focused Bun tests in
  `src/__tests__/server/formChallengeSecret.test.ts`,
  `src/__tests__/server/publicForms.test.ts`,
  `src/__tests__/plugins/pluginManifest.test.ts`,
  `src/__tests__/plugins/gatedFetchSsrf.test.ts`,
  `src/__tests__/server/pluginVmPermissions.test.ts`,
  `src/__tests__/server/pluginSecrets.test.ts`,
  `src/__tests__/server/pluginMediaAdapterBoundary.test.ts`,
  `src/__tests__/server/runtimeDependencies.test.ts`, and
  `server/publish/runtime/__tests__/cacheLayout.test.ts`; live provider/network
  permutations, true process-restart durability, and browser UI permutations
  remain operator-run.
- **SECURITY-001 remaining operator permutations** — CMS/AI invalid-origin
  mutations before DB access, safe CMS GET auth behavior, CMS namespace 405s,
  capability-before-body ordering, malformed JSON/schema body rejection,
  route-shape fuzzing across 76 CMS mutation endpoints and 11 AI mutation
  endpoints, configured custom/platform public origins at the CMS/AI boundary,
  trusted-proxy forwarded-host/proto spoof rejection at the CMS/AI boundary,
  route-table semantics, handler capability architecture gates,
  HTTP boundary-validation gates, origin helper behavior, AI driver isolation,
  and AI tool capability filtering are covered by focused Bun tests in
  `src/__tests__/server/apiSecurityBoundary.test.ts`,
  `src/__tests__/server/security.test.ts`,
  `src/__tests__/server/routeTable.test.ts`,
  `src/__tests__/server/capabilityRouteMatrix.test.ts`,
  `src/__tests__/architecture/boundary-validation.test.ts`,
  `src/__tests__/architecture/cms-handlers-capability-gated.test.ts`,
  `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`,
  `src/__tests__/architecture/ai-driver-isolation.test.ts`, and
  `src/__tests__/agent/aiToolCapabilityGate.test.ts`; live deployed smoke and
  browser-observed API error UX remain operator-run.
- **CONTENT-003 remaining media/sanitization edges, CONTENT-005 remaining
  error/mobile edges, CONTENT-007 provider-backed flows,
  and remaining CONTENT-006 field schema edges** — rich body media-picker
  insertion, sanitization, live-template missing-template/stale-state checks,
  provider-backed chat/model-test flows, custom field-schema edge cases, and
  destructive collection deletion remain agent-run or lower-level until stable
  browser fixtures exist.
  CONTENT-003 slash-menu heading/data-token persistence, CONTENT-005 template
  draft rendering, CONTENT-006 built-in collection field toggles, and
  CONTENT-007 no-provider setup guidance are automated in `content.e2e.ts`.
- **PLUGIN-001 remaining invalid-package edges, PLUGIN-005 remaining schedule edges, and PLUGIN-006 remaining pack edges** —
  need broader local plugin fixtures. PLUGIN-001 JSON-manifest permission
  review/install step-up and ZIP package review/install now have Playwright
  coverage. PLUGIN-002 has a packaged lifecycle smoke for disable, enable,
  runtime route unregistration and restoration, and uninstall cleanup.
  PLUGIN-003 has a packaged settings/secrets smoke that verifies persistence,
  accessible labels, and browser-bound secret masking. PLUGIN-004 has a
  packaged ZIP smoke for plugin admin pages, a resource record page, an app
  page asset, and an authenticated runtime route. PLUGIN-005 has a packaged
  schedule smoke for inspection, run-now, pause, and resume. PLUGIN-006 has a
  packaged site-pack smoke for auto-imported page content and re-sync feedback.
  PLUGIN-008 invalid manifest upload and recovery is automated in
  `plugins.e2e.ts`.
- **AI-001/AI-002/AI-003/AI-004/AI-005/AI-006 remaining provider-network/defaults/conversation/chat/tool-bridge/audit edges and AI-007 remaining live-driver edges** —
  live provider model tests, remaining defaults editing, conversation title/cross-user/stale-credential cases, mutating write-tool
  loops, bridge timeout/abort and malformed-result UX, dashboard/range/timezone audit views, and provider driver/pricing
  behavior remain lower-level or future fixture-backed browser coverage.
  AI-001 Ollama credential create/list/delete and offline default-guard coverage
  are automated in `ai.e2e.ts`; AI-002 Data-scope default save/reload/clear
  coverage is automated there too. AI-003 Site chat history load/new/delete,
  AI-004 fixture-backed Site assistant streaming, AI-005 browser
  `read_document` tool-result bridge, CAP-005 request-level AI write-tool filtering, and AI-006 Audit tab rollups from that
  streamed usage are also automated in `ai.e2e.ts`. AI-007 direct
  Anthropic/OpenAI/Ollama/OpenRouter driver mapping and pricing coverage is
  automated in focused Bun tests; live-provider network behaviour remains
  outside the browser suite.
- **PERF-* and remaining error-recovery sweeps**  — performance and broader
  error recovery remain observational, agent-run.
  PERF-001 and PERF-002 have Site editor startup and moderately-complex publish
  completion smokes in `performance.e2e.ts`; deeper profiling and regression
  budgeting remain agent-run.
  A11Y-001 and A11Y-002 have keyboard login and main shell navigation
  regressions in `accessibility.e2e.ts`; deeper focus-order sweeps remain
  agent-run.
  RESP-002 has a mobile public-page smoke regression in `accessibility.e2e.ts`;
  broader multi-module mobile visual review remains agent-run. REL-001 has a
  saved-edit reload-recovery smoke in `reliability.e2e.ts`; deeper crash and
  error-boundary recovery remains agent-run. REL-002 has a page-slug validation
  smoke in `error-handling.e2e.ts`; broader form/error sweeps remain agent-run.

The first reference spec remains `core-owner-lifecycle.e2e.ts`, the flagship
owner journey: login/logout, edit homepage text, save/reload, step-up-gated
publish, visitor-facing public output, and draft/public isolation after a later
unpublished edit.
