# CMS-Native Forms

CMS-native forms let the visual editor build semantic HTML forms from primitive nodes and submit them into `data_tables` / `data_rows` without custom code.

## TL;DR

- Form modules live in `src/modules/base/forms/` and register from `src/modules/base/index.ts`.
- Every form part is a node: `base.form`, `base.label`, `base.input`, `base.textarea`, `base.select`, `base.option`, `base.option-group`, `base.checkbox`, `base.radio`, `base.submit`, and `base.form-message`.
- The module picker exposes the form primitives in its Forms category; preview wireframes live in `src/admin/pages/site/module-picker/moduleWireframes.ts`.
- Paste HTML, agent HTML insert/replace, and Super Import all use `@core/htmlImport`, so semantic HTML form tags import as these same primitive modules.
- CMS form snapshots are derived from composed templates, Visual Components, params and slot fills by `src/core/forms/publishedTree.ts`, then `snapshot.ts`.
- Public submissions go through `POST /_instatic/form/challenge` and `POST /_instatic/form/submit`, implemented in `server/forms/handler.ts`.
- The browser runtime ships through the module-JS channel: `base.form`'s render() emits it as `js` for CMS/request transports and enhanced HTML actions (`src/modules/base/forms/formRuntimeJs.ts`), published pages load it from `/_instatic/module-js/base.form.js`, and `server/forms/formRuntime.ts`'s `stampFormPageTokens` stamps `data-instatic-page-token` + `data-instatic-page-id` onto every CMS form tag — on baked pages and on hole fragments.

## Editor Model

The editor exposes form primitives in the module picker.

Primitives are the source of truth. A label is a `base.label` node, an input is a `base.input` node, and a submit button is a `base.submit` node. There is no hidden field-builder shape inside `base.form`; authors compose ordinary nodes, and every node remains directly editable after insertion.

`base.form` has three declared transport modes:

- `cms` submits to a selected data table.
- `custom` renders an ordinary HTML `action` / `method` form. It ships no JavaScript unless the author enables `enhance` for native form behavior.
- `request` sends a declared multipart or JSON POST directly to `action` and consumes a declared JSON response. It uses the same native behavior runtime as CMS forms.

Form-related nodes get a contextual setup block rendered at the top of Module settings by `FormSettingsPanel` in `src/admin/pages/site/panels/PropertiesPanel/FormSettingsPanel.tsx`. The analysis that drives it lives in `src/admin/pages/site/panels/PropertiesPanel/formSettingsAnalysis.ts`. The block summarizes the nearest form, target table, bound field, inferred label/submit/message relationship, and warnings for missing tables, unbound controls, duplicate names, missing fields, controls outside forms, labels without targets, and submit buttons without forms.

For a selected `base.form` node, the setup block promotes three props — mode, Form ID, and target table — out of the generic property-control list. `renderModuleTabContent.tsx` suppresses them from the schema-driven rows via `PROMOTED_FORM_PROPERTY_KEYS`; the setup block renders them instead as a segmented mode selector and a stacked Form ID input. The target table is a live-loaded select backed by the CMS tables API. Only non-system `data` tables are eligible targets; seeded system tables such as Pages, Posts, and Components are hidden because public forms collect submissions, not site structure or core content records. Authors can also create a new `data` table from the current form controls: a dialog opens with an editable table name prefilled from a human-readable form name (generated id suffixes are stripped by `formSettingsNaming.ts` so names stay author-facing), then fields are inferred from the authored primitive nodes — ids, labels, types, required flags, and compatible validation defaults. If the selected table has fields not represented in the form, the block offers one-click insertion of label + compatible control primitives before the submit/message area.

The `Form ID` property is a machine identifier, not the author-facing table or form name. Authors use clean ids such as `contact`, `contact-2`, and `newsletter` instead of long node ids. The editor normalizes typed spaces to identifier-safe separators, and the publisher/snapshot path normalizes the same way so form messages, external submit buttons, public tokens, and submission handlers all agree on one id.

For a selected control inside a CMS-native form, the setup block exposes a field picker for compatible fields in the form's target table. Selecting a field patches the node's `fieldId`, `name`, `id`, input/control type, required state, and compatible validation defaults in one edit.

The design canvas treats authored form controls as non-interactive editor content. Inputs, textareas, selects, and buttons render as real semantic elements, but pointer/focus activation is suppressed in canvas mode so browser autofill, native select menus, and typing do not appear while designing. Clicking the element still selects the corresponding canvas node. Live preview and published pages keep normal browser form behavior.

The form setup block also exposes an editor-only preview state switch (`default`, `submitting`, `success`, `error`). It annotates the canvas form and message nodes with the same state shape the public runtime uses, without changing saved props or published HTML.

## Auto Wiring

Auto wiring is structural:

- A `base.label` with `targetMode: "auto"` targets the next form control below it in the same form subtree.
- A `base.submit` inside a form submits the nearest form by normal HTML semantics. Its `formId` prop is only an override for out-of-form submit buttons.
- `base.form-message` nodes can be inside the form or point at a form id.

The published runtime finalizes auto labels in the browser because labels and inputs are independent nodes. It assigns an id to the next control when needed and sets the label's `for` attribute.

## Submission Flow

CMS-native submission is a two-step public flow:

1. The runtime requests a short-lived challenge from `/_instatic/form/challenge` when the form attaches in the browser.
2. The runtime posts values plus the challenge to `/_instatic/form/submit`.

The submit handler reloads the latest published site snapshot, derives the form snapshot from the same native template/VC/slot composition and binding frame as the publisher, requires the target `DataTable` to be a non-system `data` table, validates fields against that table, and creates a `data_rows` record with `createDataRow`. After persistence, `server/forms/handler.ts` calls `emitContentEntryCreated` from `server/publish/contentEvents.ts` with the `system` actor, so plugins can react to successful submissions through the standard `content.entry.created` channel.

Validation lives in `src/core/forms/validation.ts`. It rejects unknown fields, enforces required fields, coerces table field types, applies email/url/number/select checks, applies control min/max/pattern constraints, and caps payload size.

## Security

The endpoint is public by necessity, so it is layered:

- Same-origin `Origin` and Fetch Metadata checks reject ordinary cross-site browser posts.
- Published-page tokens are HMAC-signed by the server and stamped into each rendered CMS form. The challenge endpoint rejects requests without the token.
- Challenges are short-lived, single-use, and bound to `pageId` + `formId`. The minimum-submit-time check is measured from challenge issue time, so the runtime prefetches challenges on form attach rather than on click.
- Challenge requests are capped at 8 KiB, submission requests at 1 MiB, before JSON validation or persistence work. Oversized payloads return `413`.
- Challenge issuance is rate-limited per IP and per IP/form pair, and the in-memory challenge store is capped to evict oldest entries under sustained pressure.
- The server trusts the published page snapshot, not client-declared fields or target tables.
- Honeypot and minimum-submit-time checks run before validation.
- Per-IP and per-IP/form rate limiters throttle repeated submissions.

No public form endpoint can be made unusable by a dedicated HTTP client that fetches the public page and behaves like a browser. The goal here is to prevent blind endpoint abuse, cross-site browser abuse, stale/forged form payloads, and high-volume spam.

## Declarative behavior and localized copy

Behavior is stored on editable native nodes; there is no opaque HTML form, per-site selector adapter, inline translation dictionary, or DOM translation pass.

| Node / property | Contract |
| --- | --- |
| `base.form-conditional.condition` | Recursive `PropertyCondition`: `eq`, `notEq`, `in`, `notIn`, `and`, `or`. Compare named control values. Hidden groups disable their controls and remove requiredness. |
| Control `requiredWhen` | Recompute requiredness from the same condition engine used by property controls, SSR and CMS validation. |
| Control `queryParameter` | Initialize a single text/select value from the browser URL, subject to authored limits and offered enabled options. |
| Control `lockQueryValue` | Lock a valid query value: readonly text controls or only the selected option enabled. The select remains enabled and submits its value. Missing query keeps the authored editable default; invalid query sets a visible invalid state and blocks submission until corrected. |
| Control `resetBehavior` | `initial` restores the effective authored/query value captured once at attachment; `clear` empties text/select values and deselects choices; `preserve` keeps the current value, including a visitor's correction. Manual resets and successful submissions use the same policy. |
| Control `valueSourceField` | A declared hidden input mirrors an enabled scalar input/textarea/select outside conditional groups. Checkbox/radio, multiple-select and file sources are rejected because they can be absent or non-scalar. CMS validation rejects forged synchronized values. |
| `base.form-output.fieldName` | Show a named control's value as plain text. |
| Control `requiredMessage` / `invalidMessage` | Authored field-local browser validation copy. |
| Form state messages | Flat authored props: `pendingMessage`, `successMessage`, `errorMessage`, `invalidMessage`, `captchaMessage`, `unavailableMessage`. |
| `base.form-message.source` | `state` shows resolved state copy; `authored` preserves an authored heading; `response` displays the recipient's plain-text message. |

State copy and labels use ordinary bindings such as `{site.translations.forms.contact.pending}`, resolved from native JSON language files. The resolved strings are emitted in HTML and reused by the native runtime; published pages do not download catalogues or run a translator. Editor state previews use that same binding context. New forms have ordinary English authoring defaults; these are not a missing-language fallback. Once localization is configured, catalogue validation rejects missing or empty keys before publication.

Selectors must be unconditional, enabled scalar controls outside conditional groups. Conditions cannot read a mirrored hidden control or a multiple select. Native preflight rejects unknown selectors, nested forms, duplicate rendered form IDs/control names, missing output sources and malformed rules. Radio groups share one name/field and validate the active published option set. Loops cannot contain form instances: their per-entry instance identity/submission authority is not modeled. CMS form definitions support stable page/site bindings and reject entry/request-dependent definitions explicitly.

SSR renders the authored initial default, derives hidden/disabled/required groups, mirrors and outputs before JavaScript. Query initialization is browser enhancement of a static page; it is not server rendering by query, a query-specific cache key, or a server authority on a locked value. The CMS recipient always validates submitted options against the published model.

The condition property control uses shared Input/Select/Button primitives and edits structured rules, including nested AND/OR. Invalid persisted rules are shown explicitly. Structured conditions do not masquerade as string VC params or accept text-token insertion. Authors can still share form components through ordinary typed params and slots.

## Declared recipient requests

For `mode: request`, configure `action`, `encoding: multipart | json`, `responseSuccessField` (default `ok`), `responseMessageField` (default `message`), and `resetOnSuccess`. The recipient must return a JSON object with a boolean success field and an optional string message field. HTTP failure, a false success field or malformed JSON produces the authored error state. Request timeout is 20 seconds and the accepted JSON response is bounded. Multipart retains native files; CMS/JSON file inputs are rejected before publication rather than losing uploaded bytes.

Reset policies belong to controls, not a form-specific callback. Reset never rereads the URL. Conditions, requiredness, outputs and synchronized hidden values are recomputed after restoring controls. An invalid initial query remains invalid under `initial`; `preserve` retains a corrected value, and `clear` discards the invalid query. A cancelled reset remains cancelled. Locked query controls cannot use `clear`, mirrored controls reset through their scalar source, and file inputs cannot use `preserve` because browsers prohibit programmatically restoring a chosen file. File inputs always clear through their native reset action.

Single-select initialization preserves an explicitly selected disabled empty placeholder. With no explicit selection it chooses the first enabled option; if multiple options are explicitly selected the last one wins, matching HTML. The canonical `resolveSelectInitialValue` helper provides that value to the publisher's form context and the canvas SelectEditor. Disabled choices remain excluded from server-side offered values, so a required empty placeholder cannot be submitted as a valid choice.

Requests use `credentials: omit`; Instatic does not proxy them, inject a secret, reinterpret the recipient's business protocol, or bypass CORS. The recipient must explicitly permit the published origin and perform its own validation. Native CMS origin/HMAC/challenge/honeypot/rate limits remain unchanged. A UI lock does not replace recipient validation.

The emitted instance declares its request origin in `connect-src` and its action origin in `form-action`. Only pages actually rendering that instance receive the additional origin; pages without it retain the normal self-only form policy. This is authored core form behavior; plugin network access still follows the plugin permission and allowed-host policy.

## Explicit Turnstile module

`base.turnstile` requires an explicit public `siteKey`, optional `action`, supported `language`, `theme` and `responseFieldName`. It has no demo key or secret default. An unconfigured key, unsupported language/action, duplicate widget or widget in a conditional group blocks publication. The widget's script/frame CSP origins are collected only where it renders.

The runtime loads the official explicit widget script, renders once, blocks submission without a token, handles expiration/errors/timeouts and resets after an attempt. A failed loader can retry. There is one generic runtime emitted by the form root; controls, conditions, outputs and widgets do not emit duplicate runtimes.

Turnstile is available on recipient/HTML-action forms whose server validates the token. CMS forms retain Instatic's native challenge and reject a vendor widget because CMS Siteverify/secret configuration is not implemented. The browser widget alone is not proof of server verification; the recipient must call Siteverify. Cloudflare documents a five-minute, single-use token. See [server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [widget configuration](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/), [supported language codes](https://developers.cloudflare.com/turnstile/reference/supported-languages/) and [CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).

## Engine, generation and publication preflight

- Canonical TypeBox shapes: `src/core/forms-schema/`; recursive conditions are owned by the pure `value-conditions-schema` leaf and evaluated by `value-conditions`; primitive props are shared between module definitions and canvas components in `primitiveSchemas.ts`.
- Composition and binding authority: `forms/publishedTree.ts` calls the single `buildTemplateRenderContext` also used by the publisher. Consumer slot fills retain structured dynamic bindings.
- Initial SSR context: `forms/renderContext.ts`; table/active-option validation: `forms/validation.ts`.
- Browser source: `modules/base/forms/runtime.ts` and `runtimeEntry.ts`. Run `bun run forms:sync` after changing runtime source or its schemas; `forms:check` and the architecture freshness test compare the committed artifact. TypeBox generates static validators during tooling, so published JavaScript has neither a runtime schema compiler nor unsafe eval.
- `assertSiteForms` runs before publication builds, snapshot/version writes and artefact swaps. `FormConfigurationError` returns an actionable HTTP 422 path. Failed preflight preserves the previous publication.

Verification covers nine catalogue frames through native VC params/slots, editor state copy, SSR groups, CMS HMAC challenge/submit/replay, active/required/option validation, browser conditions/query locks, request encodings, plain-text response safety, CAPTCHA expiration/retry, publication atomicity and generated-runtime freshness. Recipient requests and provider calls use isolated mocks; these checks do not claim a live recipient or real CAPTCHA service submission.

## Related

- [Content storage](content-storage.md) — `data_tables` and `data_rows`
- [Modules](modules.md) — module definitions and the module picker
- [Publisher](publisher.md) — HTML pipeline and runtime injection
- [TypeBox patterns](../reference/typebox-patterns.md) — request/response validation
- Source of truth — module definitions: `src/modules/base/forms/index.ts`
- Source of truth — form settings panel: `src/admin/pages/site/panels/PropertiesPanel/FormSettingsPanel.tsx`
- Source of truth — settings analysis: `src/admin/pages/site/panels/PropertiesPanel/formSettingsAnalysis.ts`
- Source of truth — naming utilities: `src/admin/pages/site/panels/PropertiesPanel/formSettingsNaming.ts`
- Source of truth — target table restriction: `src/core/forms/targets.ts`
- Source of truth — submission handler: `server/forms/handler.ts`
