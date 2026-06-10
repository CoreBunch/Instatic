# Per-module published-JS channel — Design

Date: 2026-06-10
Status: approved (approach 2A: render-emitted JS, per-module external assets)

## Goal

Modules can ship a small vanilla-JS runtime with published pages. `RenderOutput` becomes `{ html, css?, js? }`, JS is deduped per `moduleId` exactly like CSS, served as per-module external assets, and injected only on pages that actually use those modules. The hand-special-cased form runtime migrates onto the channel as its first consumer, leaving exactly one mechanism. No editor UI in v1 — this is groundwork for upcoming first-party interactive modules (nav, accordion, tabs, modal).

## Contract

- `src/core/module-engine/types.ts`: `RenderOutput` gains `js?: string`. The plugin SDK mirror (`src/core/plugin-sdk/modules.ts` `PluginRenderOutput`) gains the same field.
- **Authoring contract (documented):** module JS must be a self-contained vanilla IIFE; bind via document-level event delegation (hole fragments insert into the DOM after load); idempotent; no load-order assumptions; no framework runtimes. Size discipline in the spirit of the ~1 KB hole runtime — the 8.3 KB form runtime is the ceiling, not the norm.
- Module JS never executes in the admin canvas: the canvas renders React editor components, never published `render()` output. (Documented, not enforced by code.)

## Collection

- `RenderAccumulators` gains `jsMap: Map<string, string>` mirroring `cssMap`; `renderNode` stores `output.js` on the first render of each `moduleId`. No `</script>`-escaping needed — JS is served as an external file, never inlined.
- Site-wide collection at publish time: the same full-tree walk as `collectAllModuleCss` (which renders complete trees, including hole subtrees) builds the site `jsMap`, memoised per `publishVersion` following the `buildPublishedSiteCssBundle` pattern (invalidated by `bumpPublishVersion()`).

## Serving

- New asset route `GET /_instatic/module-js/<moduleId>.js?v=<publishVersion>`, handler mirroring the hole-runtime/form-runtime asset serving: body from the memoised site `jsMap`; 404 for unknown moduleId; `content-type: text/javascript`; `cache-control: public, max-age=3600` (`?v=` busts on publish).

## Per-page injection

- During page bake, compute `pageJsModuleIds` = (modules that emitted `js` during this page's render) ∪ (moduleIds present in this page's hole subtrees ∩ site `jsMap` keys). The static hole-subtree walk is what fixes today's gap where hole fragments bypass the HTML pipeline.
- New pipeline step `injectModuleScripts` replaces `injectFormRuntime`'s script-injection half: appends one `<script src="/_instatic/module-js/<id>.js?v=N" defer data-instatic-module-js="<id>">` per module, sorted by moduleId for determinism, before `</body>`; relaxes CSP `script-src` to `'self'` iff at least one script was injected (generalizing `relaxScriptCsp`).
- Known acceptable over-inclusion: a page whose only form is `static`-mode still loads the form runtime *iff* the form sits inside a hole subtree and some other page uses `cms` mode (membership is per-module, render-conditional emission can't be evaluated for unbaked holes). The runtime no-ops without matching forms.

## Form runtime migration

- `FORM_RUNTIME_JS` moves into the `base.form` module and is emitted as `render()` `js` only when `mode === 'cms'`. The dedicated `/_instatic/form-runtime.js` route, `injectFormRuntime`'s script half, and the regex-based `pageHasCmsNativeForm` detection are **deleted** (pre-release, no backcompat).
- `stampFormPageTokens` survives as its own pipeline step — token stamping is an HTML mutation, not JS injection. It is **additionally applied to hole fragment HTML** in `handleHoleRequest`, so forms inside lazy holes get both tokens and (via tree-walk injection) the runtime — fixing a real pre-existing bug where hole-contained forms got neither.

## Plugin modules and security

- The QuickJS bootstrap's `normalizeRenderOutput` (authored in `server/plugins/quickjs/bootstrap/src/`) passes `js` through string-typed; after editing run `bun run bootstrap:sync` (gated by `plugin-bootstrap-fresh.test.ts`).
- Host-side enforcement in `moduleAdapter`: `js` from a plugin module's render output is **dropped unless the plugin's `grantedPermissions` include `frontend.assets`** — the existing permission that already means "may inject script tags into published pages" (enforced in `frontendInjections.ts` the same way). Dropping logs `console.warn('[plugin:<id>] …')` once per module. Enforcement checks `grantedPermissions`, never the declared `permissions` array.
- Manifest format unchanged.

## Error handling

- Unknown moduleId on the asset route → 404 with the standard error envelope semantics for public assets (plain 404, no envelope — public route).
- Module emits non-string `js` → ignored (type-level for first-party; normalizer drops it at the VM boundary for plugins).

## Testing

- Publisher: `jsMap` dedupe (one entry per moduleId); scripts injected only on pages whose trees contain JS-emitting modules; hole-subtree modules included; deterministic script order; CSP `script-src 'self'` added iff scripts present, absent otherwise.
- Forms: existing `formRuntime.test.ts` coverage migrates — runtime script present on cms-form pages and absent on pages without them; tokens stamped on baked pages *and* hole fragments; form submission still works end-to-end.
- Plugins: `js` crosses the VM boundary; dropped without `frontend.assets`; published with it.
- Architecture: `plugin-bootstrap-fresh.test.ts` stays green (bootstrap re-synced); asset-route architecture test following `hole-runtime-asset-route.test.ts`.
- `bun test`, `bun run build`, `bun run lint` clean.

## Docs

Update `docs/features/publisher.md` (JS channel section in the pipeline description), module authoring docs (`docs/features/modules.md` or equivalent), and `docs/features/plugin-system.md` (the `frontend.assets` gate on module JS) in the same change.
