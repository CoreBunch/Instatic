# CMS-Native Forms

CMS-native forms let the visual editor build semantic HTML forms from primitive nodes and submit them into `data_tables` / `data_rows` without custom code.

## TL;DR

- Form modules live in `src/modules/base/forms/` and register from `src/modules/base/index.ts`.
- Every form part is a node: `base.form`, `base.label`, `base.input`, `base.textarea`, `base.select`, `base.option`, `base.option-group`, `base.checkbox`, `base.radio`, `base.submit`, and `base.form-message`.
- Presets in `src/admin/pages/site/module-picker/formPresets.ts` insert ordinary primitive nodes; nothing is hidden inside the preset.
- Paste HTML, agent HTML insert/replace, and Super Import all use `@core/htmlImport`, so semantic HTML form tags import as these same primitive modules.
- CMS form snapshots are derived at publish/request time by `src/core/forms/snapshot.ts`.
- Public submissions go through `POST /_instatic/form/challenge` and `POST /_instatic/form/submit`, implemented in `server/forms/handler.ts`.
- The browser runtime ships through the module-JS channel: `base.form`'s render() emits it as `js` when `mode === 'cms'` (`src/modules/base/forms/formRuntimeJs.ts`), published pages load it from `/_instatic/module-js/base.form.js`, and `server/forms/formRuntime.ts`'s `stampFormPageTokens` stamps `data-instatic-page-token` + `data-instatic-page-id` onto every CMS form tag — on baked pages and on hole fragments.

## Editor Model

The editor exposes both primitives and presets.

Primitives are the source of truth. A label is a `base.label` node, an input is a `base.input` node, and a submit button is a `base.submit` node. Presets only save clicks by inserting a subtree such as contact or newsletter; after insertion, the user edits the same nodes they would have created manually.

`base.form` has two modes:

- `cms` submits to a selected data table.
- `custom` renders a semantic form shell with `action` / `method` for external adapters or traditional form targets.

Form-related nodes get a contextual setup block rendered at the top of Module settings by `FormSettingsPanel` in `src/admin/pages/site/panels/PropertiesPanel/FormSettingsPanel.tsx`. The analysis that drives it lives in `src/admin/pages/site/panels/PropertiesPanel/formSettingsAnalysis.ts`. The block summarizes the nearest form, target table, bound field, inferred label/submit/message relationship, and warnings for missing tables, unbound controls, duplicate names, missing fields, controls outside forms, labels without targets, and submit buttons without forms.

For a selected `base.form` node, the setup block promotes three props — mode, Form ID, and target table — out of the generic property-control list. `renderModuleTabContent.tsx` suppresses them from the schema-driven rows via `PROMOTED_FORM_PROPERTY_KEYS`; the setup block renders them instead as a segmented mode selector and a stacked Form ID input. The target table is a live-loaded select backed by the CMS tables API. Only non-system `data` tables are eligible targets; seeded system tables such as Pages, Posts, and Components are hidden because public forms collect submissions, not site structure or core content records. Authors can also create a new `data` table from the current form controls: a dialog opens with an editable table name prefilled from a human-readable form name (generated id suffixes are stripped by `formSettingsNaming.ts` so names stay author-facing), then fields are inferred from the authored primitive nodes — ids, labels, types, required flags, and compatible validation defaults. If the selected table has fields not represented in the form, the block offers one-click insertion of label + compatible control primitives before the submit/message area.

The `Form ID` property is a machine identifier, not the author-facing table or form name. Presets use clean ids such as `contact`, `contact-2`, and `newsletter` instead of long node ids. The editor normalizes typed spaces to identifier-safe separators, and the publisher/snapshot path normalizes the same way so form messages, external submit buttons, public tokens, and submission handlers all agree on one id.

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

The submit handler reloads the latest published site snapshot, derives the form snapshot from the published page tree, requires the target `DataTable` to be a non-system `data` table, validates fields against that table, and creates a `data_rows` record with `createDataRow`.

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
