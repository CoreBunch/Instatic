# CMS-Native Forms

CMS-native forms let the visual editor build semantic HTML forms from primitive nodes and submit them into `data_tables` / `data_rows` without custom code.

## TL;DR

- Form modules live in `src/modules/base/forms/` and register from `src/modules/base/index.ts`.
- Every form part is a node: `base.form`, `base.label`, `base.input`, `base.textarea`, `base.select`, `base.option`, `base.option-group`, `base.checkbox`, `base.radio`, `base.submit`, and `base.form-message`.
- The module picker exposes the form primitives in its Forms category; preview wireframes live in `src/admin/pages/site/module-picker/moduleWireframes.ts`.
- Paste HTML, agent HTML insert/replace, and Super Import all use `@core/htmlImport`, so semantic HTML form tags import as these same primitive modules.
- CMS form snapshots are derived at publish/request time by `src/core/forms/snapshot.ts`.
- Public submissions go through `POST /_instatic/form/challenge` and `POST /_instatic/form/submit`, implemented in `server/forms/handler.ts`.
- The browser runtime ships through the module-JS channel: `base.form`'s render() emits it as `js` when `mode === 'cms'` (`src/modules/base/forms/formRuntimeJs.ts`), published pages load it from `/_instatic/module-js/base.form.js?v=<contentHash>` (the hash of the runtime body, so a changed runtime is a new URL), and `server/forms/formRuntime.ts`'s `stampFormPageTokens` stamps `data-instatic-page-token` + `data-instatic-page-id` onto every CMS form tag — on baked pages and on hole fragments.

## Editor Model

The editor exposes form primitives in the module picker.

Primitives are the source of truth. A label is a `base.label` node, an input is a `base.input` node, and a submit button is a `base.submit` node. There is no hidden field-builder shape inside `base.form`; authors compose ordinary nodes, and every node remains directly editable after insertion.

Every form part except `base.form-message` also carries an `htmlAttributes` bag (the Properties panel's Attributes view) for native attributes the module does not model, such as `inputmode`, `step`, `aria-describedby` and `data-*` hooks. The module emits its own attributes first and the bag after them, so a duplicate name never overrides a module-owned value (the browser keeps the first). HTML import fills the bag (see [html-import.md](html-import.md)).

`base.form` has three modes:

- `cms` submits to a selected data table.
- `member` performs a member account action.
- `custom` renders a semantic form shell with `action` / `method` for external adapters or traditional form targets.

Form-related nodes get a contextual setup block rendered at the top of Module settings by `FormSettingsPanel` in `src/admin/pages/site/panels/PropertiesPanel/FormSettingsPanel.tsx`. The analysis that drives it lives in `src/admin/pages/site/panels/PropertiesPanel/formSettingsAnalysis.ts`. The block summarizes the nearest form, target table, bound field, inferred label/submit/message relationship, and warnings for missing tables, unbound controls, duplicate names, missing fields, controls outside forms, labels without targets, and submit buttons without forms.

Selecting a form shows its destination, its response after submission, and an **Edit form settings** button. The dialog opens to **Destination**, which groups the CMS table picker, member action setup, and custom endpoint controls with their respective modes. **After submission** configures a message or redirect for CMS and member forms. A custom endpoint handles its own response. **Advanced** holds Form ID and CMS spam protection. Edits use the normal editor mutations. **Done** closes the dialog.

The target table is a live-loaded select backed by the CMS tables API. Only non-system `data` tables are eligible targets; seeded system tables such as Pages, Posts, and Components are hidden because public forms collect submissions, not site structure or core content records. Authors can also create a new `data` table from the current form controls: a dialog opens with an editable table name prefilled from a human-readable form name (generated id suffixes are stripped by `formSettingsNaming.ts` so names stay author-facing), then fields are inferred from the authored primitive nodes — ids, labels, types, required flags, and compatible validation defaults. If the selected table has fields not represented in the form, the block offers one-click insertion of label + compatible control primitives before the submit/message area.

The `Form ID` property is a machine identifier, not the author-facing table or form name. Authors use clean ids such as `contact`, `contact-2`, and `newsletter` instead of long node ids. The editor normalizes typed spaces to identifier-safe separators, and the publisher/snapshot path normalizes the same way so form messages, external submit buttons, public tokens, and submission handlers all agree on one id.

For a selected control inside a CMS-native form, the setup block exposes a field picker for compatible fields in the form's target table. Selecting a field patches the node's `fieldId`, `name`, `id`, input/control type, required state, and compatible validation defaults in one edit.

The design canvas treats authored form controls as non-interactive editor content. Inputs, textareas, selects, and buttons render as real semantic elements, but pointer/focus activation is suppressed in canvas mode so browser autofill, native select menus, and typing do not appear while designing. Clicking the element still selects the corresponding canvas node. Live preview and published pages keep normal browser form behavior.

The sidebar also exposes an editor-only **Canvas preview** dropdown (`default`, `submitting`, `success`, `error`). It annotates the canvas form and message nodes with the same state shape the public runtime uses, without changing saved props or published HTML.

## Member mode

`mode: 'member'` turns the form into a member action (sign up, sign in, reset password, update profile, …) instead of a table submission. It posts to `/_instatic/members/<action>` and has no target table, honeypot or challenge: the member endpoints carry their own origin checks and rate limits. See [members](members.md) → "Building member pages in the editor".

`base.form-message` with `kind: error` can name one field (`fieldName`); it then shows only errors about that field.

## Auto Wiring

Auto wiring is structural:

- A `base.label` with `targetMode: "auto"` targets the next form control below it in the same form subtree.
- A `base.submit` inside a form submits the nearest form by normal HTML semantics. Its `formId` prop is only an override for out-of-form submit buttons.
- `base.form-message` nodes can be inside the form or point at a form id; a form uses both. The one exception is a form repeated in a list: its id occurs more than once on the page, so a row that holds messages uses only its own.

The published runtime finalizes auto labels in the browser because labels and inputs are independent nodes. It assigns an id to the next control when needed and sets the label's `for` attribute.

## Submission Flow

CMS-native submission is a two-step public flow:

1. The runtime requests a short-lived challenge from `/_instatic/form/challenge` when the form attaches in the browser.
2. The runtime posts values plus the challenge to `/_instatic/form/submit`.

The challenge response carries `expiresInSeconds` and the form's `minSubmitSeconds`. The runtime (`src/modules/base/forms/formRuntimeJs.ts`) uses them so a visitor who lingers is not turned away:

- It measures the challenge lifetime from the moment the response arrived, on the browser's own clock. The absolute `expiresAt` is never compared with the browser clock, so a visitor clock that disagrees with the server's changes nothing.
- It replaces the held challenge 30 seconds before it expires, for as long as the form stays in the page.
- The server's time trap counts from the challenge's issue time. When the visitor has had the form for at least `minSubmitSeconds` but the challenge in hand is younger than that (just refreshed, or fetched at submit because the earlier one expired or never arrived), the runtime waits out the difference before posting. A submit made sooner than `minSubmitSeconds` after the form attached is posted immediately and the server rejects it with `Form submitted too quickly`.

The submit handler reloads the latest published site snapshot, derives the form snapshot from the published page tree, requires the target `DataTable` to be a non-system `data` table, validates fields against that table, and creates a `data_rows` record with `createDataRow`. After persistence, `server/forms/handler.ts` calls `emitContentEntryCreated` from `server/publish/contentEvents.ts` with the `system` actor, so plugins can react to successful submissions through the standard `content.entry.created` channel.

Validation lives in `src/core/forms/validation.ts`. It rejects unknown fields, enforces required fields, coerces table field types, applies email/url/number/select checks, applies control min/max/pattern constraints, and caps payload size. A `select` or `multiSelect` submission may carry an option's `value` (what `base.option` nodes inserted from the table hold) or its `id`; the stored cell is always the option id.

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
