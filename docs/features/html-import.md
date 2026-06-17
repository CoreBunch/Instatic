# HTML Import

`src/core/htmlImport` converts an HTML string into a flat fragment of first-class `PageNode`s that callers splice directly into the live page tree.

The module has two consumers: the paste-HTML UI and the AI agent's `insertHtml` / `replaceNodeHtml` tools. Both call the same `importHtml(source)` entry point — no duplicated mapping logic.

---

## TL;DR

- Single entry point: `importHtml(source)` → `{ nodes, rootIds, body?, stripped, styleCss }`.
- Pipeline: `parseHtml` → `harvestInlineStyles` + `collectStyleCss` → `stripUnsafe` → `walkAndMap`.
- Mapping is rule-driven (`HTML_TO_MODULE_RULES`). The catch-all `*` rule guarantees every element produces a node — nothing falls through.
- Every produced node is a real `PageNode`: selectable, draggable, deletable, and re-styleable in the canvas.
- HTML class names ride onto `node.classIds` during the pure walk; `insertImportedNodes` then links each name to a real registry class id (reusing a same-named class, binding to a parsed `<style>` rule of that name, or auto-creating a bare one) so the class renders and is editable.
- **CSS is preserved.** Inline `style="…"` lands on `node.inlineStyles` (the editor's per-node style layer); `<style>` blocks are returned as raw `styleCss`, which consumers parse via `cssToStyleRules` into registry rules shown in the Selectors panel. Only the security-denied property names are dropped.
- UX entry points: Spotlight **Import HTML** command and right-click **Paste HTML here…** on any container node.

---

## Where the code lives

```text
src/core/htmlImport/
├── index.ts           — public barrel; all exports below go through here
├── parseHtml.ts       — DOMParser.parseFromString wrapper (browser-only; tests polyfill via happy-dom)
├── stripUnsafe.ts     — removes <script>, on* attrs (counted), <style>+style= (harvested first); collectStyleCss returns the <style> CSS
├── inlineStyle.ts     — harvests the full inline style="" bag (security-gated) before it is stripped
├── rules.ts           — HTML_TO_MODULE_RULES declarative mapping table
└── walkAndMap.ts      — DOM walker + importHtml() entry point

src/admin/modals/ImportHtml/
├── ImportHtmlModal.tsx        — modal: CodeMirror HTML editor, DOM-tree preview, error alert, footer buttons
├── ImportHtmlModal.module.css
└── index.ts                   — barrel re-export

src/admin/spotlight/commands/importHtml.ts  — Spotlight command editor.importHtml
src/__tests__/htmlImport/mapping.test.ts    — per-rule unit tests
```

---

## The pipeline

`importHtml(source)` runs these steps in sequence:

```text
importHtml(source: string)
  1. parseHtml(source)            — new DOMParser().parseFromString(source, 'text/html')
                                    Returns a DOM Document. Uses the global DOMParser;
                                    no server-side DOM library is imported.
  2. harvestInlineStyles(doc)     — captures each element's full inline style="" bag
                                    (camelCase, security-gated) BEFORE step 4 removes
                                    the style attribute. Keyed by Element.
     collectStyleCss(doc)         — concatenates every <style> block's CSS BEFORE
                                    step 4 removes the <style> elements.
  3. stripUnsafe(doc)             — mutates doc in place; returns StripReport
  4. walkAndMap(doc, inlineStyles)— maps doc.body element children to PageNodes,
                                    attaching each harvested inline bag to its
                                    node's `inlineStyles`. Returns { nodes, rootIds }
→ { nodes, rootIds, body?, stripped, styleCss }   (ImportResult)
```

### Return type

```ts
interface ImportResult {
  /** All produced nodes, keyed by id. A node may carry `inlineStyles` (the
   *  per-node `style=""` layer) populated from its inline style attribute. */
  nodes: Record<string, PageNode>
  /** IDs of the top-level nodes (direct children of doc.body), in document order. */
  rootIds: string[]
  /** Source <body> classes, safe HTML attribute props, and inline styles, kept off rootIds. */
  body?: {
    classIds?: string[]
    props?: Record<string, unknown>
    inlineStyles?: Record<string, string>
  }
  /** Counts of constructs removed by stripUnsafe (scripts, inline handlers). */
  stripped: StripReport
  /** Raw concatenated CSS from <style> blocks. Empty when the source had none. */
  styleCss: string
}
```

Callers splice the fragment into the page tree via `insertImportedNodes(parentId, fragment, opts?)` in the editor store — one `mutateActiveTreeAndSite` call, one undo step. Any `node.inlineStyles` set during the walk rides along on the node verbatim (it is a first-class node field), so the publisher emits it as a `style="…"` attribute and the editor's inline-style layer (and `BackgroundImageControl`) shows it. Whole-site import applies `fragment.body` to the page's `base.body` root so body-level classes, safe HTML attributes, and inline styles preserve template-wide styling hooks without creating a fake child node.

**`<style>` blocks → Selectors panel.** `importHtml` does NOT parse CSS itself (that would couple `@core/htmlImport` to `@core/siteImport` and lose the site's breakpoint context). Instead it returns the raw `styleCss`; each consumer parses it with `cssToStyleRules(styleCss, { breakpoints })` and passes the resulting `{ styleRules, conditions }` to `insertImportedNodes(parentId, fragment, { styleRules, conditions })`. Class rules whose name matches a node's `class=` token bind to that node (the merge runs before class-name linking); ambient rules (`body`, `a:hover`, …) register globally. All appear in the Selectors panel. The whole-site Super Import path folds each page's `<style>` CSS in as a synthetic per-page source (`<htmlPath>::inline`) so it scopes, resolves `url(…)` assets, and detects conflicts exactly like a linked stylesheet.

---

## Mapping rules

`HTML_TO_MODULE_RULES` in `src/core/htmlImport/rules.ts` is a declarative array of `ImportRule` objects. The walker tests each element against the rules in order; the first match wins. The last rule is always `*`, so every element is guaranteed to match.

| Selector | Module | Props set | Recurse |
|---|---|---|---|
| `instatic-outlet` | `base.outlet` | none (the CMS content outlet) | **No** |
| `instatic-loop` | `base.loop` | `sourceId`, `filters.tableId`, `orderBy`, `direction`, `limit`, `offset`, `pagination`, `pageSize`, optional `tag` / `customTag` from `data-*` attrs | Yes |
| `h1`–`h6`, `p`, `span`, `small`, `strong`, `em` | `base.text` | `text` = `el.textContent`, `tag` = tag name | No |
| `a` with class `btn` | `base.button` | `label` = `el.textContent`, `href`, `target` | No |
| `a` (no `btn` class) | `base.link` | `text` = `el.textContent`, `href`, `target` | No |
| `img` | `base.image` | `src` = `src` attribute only | No |
| `form` | `base.form` | `mode`, `formId`, CMS data attrs, custom `action` / `method` | Yes |
| `label` | `base.label` unless wrapping elements, then `base.container` | `text`, `targetMode`, `targetId` | No for plain labels; yes for wrapper labels |
| `input` | `base.input`, `base.checkbox`, `base.radio`, `base.submit`, or `base.button` | Native form attrs modeled by the target module | No |
| `textarea` | `base.textarea` | `fieldId`, `name`, `id`, `placeholder`, `value`, validation attrs | No |
| `select` | `base.select` | `fieldId`, `name`, `id`, `required`, `disabled`, `multiple` | Yes |
| `optgroup` | `base.option-group` | `label`, `disabled` | Yes |
| `option` | `base.option` | `value`, `label`, `selected`, `disabled` | No |
| `button` | `base.button`, or `base.submit` when submit-type / inside a form without a type | `label`, `disabled` | No |
| `ul`, `ol` | `base.container` | `tag` = tag name | Yes |
| `div`, `section`, `article`, `main`, `header`, `footer`, `nav`, `aside` | `base.container` | `tag` = tag name | Yes |
| `area`, `base`, `br`, `col`, `embed`, `hr`, `link`, `meta`, `param`, `source`, `track`, `wbr` (void elements) | `base.container` | `tag: 'custom'`, `customTag` = tag name | **No** |
| `*` (catch-all) | `base.container` | `tag: 'custom'`, `customTag` = tag name | Yes |

**Key details:**

- **`<instatic-outlet>` → `base.outlet`.** The custom element marks where matched content flows in a CMS template. It maps to a childless `base.outlet` node (any inner markup is ignored — the composer fills it). This rule lets the AI agent and hand-authored template HTML place the single content outlet inline via the normal import path. See [templates.md](templates.md) and [agent.md](agent.md).
- **`<instatic-loop>` → `base.loop`.** The custom element lets the AI agent and hand-authored snippets create a real Loop through the same HTML import path. Children recurse normally and become loop variants. Loop configuration is read from attributes: `data-source-id`, `data-table-id` (stored as `filters.tableId`), `data-order-by`, `data-direction`, `data-limit`, `data-offset`, `data-pagination`, `data-page-size`, and optional `data-tag` / `data-custom-tag`. See [loops.md](loops.md) and [agent.md](agent.md).
- `base.text` uses `tag` (not a separate `level` or heading prop) — the tag name is passed through directly. Imported bare DOM text uses `tag: 'none'`, which publishes text without an element wrapper.
- **Direct text inside a recursing container is preserved.** The walker iterates `childNodes` (not just `children`): element children route through the rules, and each significant text node becomes a synthesized `base.text` child with `tag: 'none'` in document order. That no-wrapper text mode publishes back to bare text, so `<div class="num">98%</div>` and `<li>Buy milk</li>` import as containers holding their original text without adding selector-visible wrapper elements. Whitespace-only text (indentation between tags) is skipped; internal whitespace runs collapse to single spaces, and boundary spaces are kept when the text run sits between element siblings.
- **`<body>` metadata is preserved separately.** Classes, safe HTML attributes (`id`, ARIA, `data-*`, etc.), and harvested inline styles on `<body>` are returned as `fragment.body` rather than inserted into `rootIds`. Full-site import applies them to `base.body`; paste-style HTML import can ignore them without changing the fragment structure.
- `base.link` uses the prop `text` (not `label`). `base.button` uses `label` (not `text`). These match the module source.
- `base.image` captures `src` only. `alt` is not a per-instance prop — it comes from the media library asset.
- **Form elements import as form primitives.** Third-party `<form>` elements default to `base.form` in `custom` mode, so they do not become CMS submission endpoints until an author binds them to a data table. Published CMS-native forms can round-trip their `data-instatic-*` form metadata. Plain labels become `base.label`; labels that wrap controls become a `base.container` with `customTag:'label'` so nested inputs are not dropped.
- **Void elements** (`<br>`, `<hr>`, etc.) have their own rule that sits before the catch-all. They map to `base.container` with `tag:'custom'` + the real tag name, but with `recurse:false` so the produced node has no children. `<input>` is not part of this fallback anymore; it imports through the form-control rule. The canvas renderer (`ContainerEditor`) also guards against passing children (including the empty-container placeholder) to void element tags, because React throws if you do so.
- The catch-all (`*`) handles `li`, `figure`, `blockquote`, `table`, `dialog`, and anything else not listed. It uses `tag: 'custom'` + `customTag` so `resolveHtmlTag` in `base.container` emits the real element name. Using `tag: 'div'` + `customTag` would render `<div>` instead.
- The pure `walkAndMap` step copies element class *names* onto `node.classIds` (`Array.from(el.classList)`) — it is registry-agnostic and infers no styles. The store action that splices the fragment in (`insertImportedNodes`) then converts those names to real class ids (see [Class linking](#class-linking-name--id)).

---

## What gets stripped vs. preserved

`stripUnsafe` (`src/core/htmlImport/stripUnsafe.ts`) mutates the parsed document before the walker runs. CSS is harvested first (see the pipeline above), so `<style>` and `style="…"` are removed from the DOM but **not dropped from the import**:

| Construct | Treatment |
|---|---|
| `<script>` elements | Stripped — counted as `stripped.scripts` |
| Inline `on*` attributes (`onclick`, `onload`, …) | Stripped — counted as `stripped.inlineHandlers` |
| `<style>` elements | CSS harvested into `result.styleCss` (then parsed into registry rules); the element is removed |
| `style="…"` attributes | Declarations harvested onto `node.inlineStyles`; the attribute is removed |
| HTML comments and processing instructions | Stripped silently — no count |

The AI agent should not use stripped constructs for behavior. If an edit needs JavaScript, it writes a real runtime script with `write_code_asset({ type: "script", ... })` and verifies targeting with `inspect_code_runtime` instead of embedding `<script>` or `onclick` in an HTML import.

After insert, `ImportHtmlModal` builds a toast body from the added-selector count plus the non-zero stripped counts, e.g. `"3 CSS selectors, stripped 2 <script>"`. If nothing notable happened, the toast shows only the node count.

**Inline `style="…"` → `node.inlineStyles`.** Before `stripUnsafe` removes a `style` attribute, `harvestInlineStyles` (`inlineStyle.ts`) reads the element's parsed CSSOM declaration and copies **every** declaration into a camelCase bag, dropping only property names rejected by `isEmittableProperty` (the publisher's security denylist — the same gate `cssToStyleRules` uses). A `url(…)` background is canonicalised to `url('payload')` form so the Super Import asset rewriter and the editor's `BackgroundImageControl` recognise it. The bag is attached to the produced node as `node.inlineStyles` — the editor's first-class per-node `style=""` layer — which the publisher emits verbatim and the user edits via the Properties panel's inline-style mode. In Super Import any `url(…)` is uploaded to the media library and rewritten to its media URL.

---

## What is lossy by design

The importer is "approximate by construction". Several inputs do not survive the round-trip:

| Input | What happens | Why |
|---|---|---|
| `alt=""` on `<img>` | Dropped | `base.image` has no `alt` prop — alt text is stored on the media library asset |
| Safe HTML attributes not modeled by the matched module (`id`, ARIA attrs, `role`, custom attrs, `data-*`, etc.) | Preserved in `props.htmlAttributes` on base container/text/link/button/image nodes and editable in the Properties panel Attributes view. `class` names become registry classes, inline `style` declarations become `node.inlineStyles`, event handlers are stripped, reserved editor/runtime `data-*` names are not imported, and attributes already owned by the module (for example `href` on links and `src` on images) stay in their first-class module props. | The module schema owns modeled props; `htmlAttributes` is the safe escape hatch for extra authored attributes |
| Exact inline whitespace around mixed content (`<div>Hello <em>world</em></div>`) | Approximated | Each text run becomes a `base.text` child with `tag: 'none'` and whitespace collapsed to single spaces. True parent-edge indentation is trimmed, but a single boundary space is preserved around element siblings so `Hello <em>world</em>` does not become `Helloworld`. The text itself is **preserved** and publishes without an extra wrapper. |
| Whitespace-only text (newlines/indentation between tags) | Dropped | It carries no content — collapsing it would add empty text nodes to every pretty-printed snippet |
| Void elements (`<br>`, `<hr>`, etc.) | Imported as a childless `base.container` node with `tag:'custom'` and the real tag name as `customTag`. No children, no empty-container placeholder. `<input>` imports as a form primitive instead. | React throws if children are rendered inside void element tags; the dedicated void-element rule (before the catch-all) sets `recurse:false` and the canvas renderer skips children entirely for void tags. |

These losses are deliberate. The importer is a structural bootstrap, not a fidelity snapshot.

---

## The UX

Three entry points all open the same `ImportHtmlModal`:

1. **Spotlight palette** — type "Import HTML" (`editor.importHtml` command, `code` icon). Opens with no parent pre-set (defaults to the page root) and an empty editor.
2. **DOM panel context menu** — right-click any container node → **Paste HTML here…**. The clipboard is read and pre-fills the editor; `parentId` is pre-set to the right-clicked node.
3. **Canvas context menu** — same as DOM panel, via `CanvasRoot.handlePasteHtml`.

The modal is a two-column dialog — HTML editor on the left (wider), tree preview on the right (narrower):
- **CodeMirror HTML editor** (left column) — paste or type HTML. Error alerts appear inline in the column header when insertion fails.
- **Tree preview** (right column) — 200 ms debounced DOM-style tree view using the same row components as the Layers panel. Updates as the user types.
- **Insertion target** — taken from the opener's `parentId`; Spotlight defaults to the page root. There is no parent picker in the modal.
- **Insert** button (footer) — runs `importHtml`, calls `insertImportedNodes`, shows a success toast (with optional stripped-count detail), closes the modal.

After insert, every produced node is a normal canvas node. It can be selected, moved, re-styled, and deleted like any other node.

`ImportHtmlModal` is lazy-mounted in `AdminCanvasEditorBody.tsx` gated by
`importHtmlModalOpen`. While the modal chunk downloads, the body renders the
same dialog chrome with a two-column loading skeleton so opening the command
has immediate feedback:

```tsx
{importHtmlModalOpen && (
  <Suspense fallback={<ImportHtmlModalLoading />}>
    <ImportHtmlModal />
  </Suspense>
)}
```

---

## Class linking (name → id)

The engine's style rule registry (`site.styleRules`) is keyed by a generated **id**, and every renderer resolves a node's classes by id (`classNamesForClassIds` → `styleRules[classId].name`). HTML, however, carries class **names**. The two layers reconcile in `insertImportedNodes` (`src/admin/pages/site/store/slices/site/nodeActions.ts`):

1. The pure `walkAndMap` step writes raw names onto `node.classIds` (it has no `SiteDocument`, so it cannot mint ids).
2. As the fragment is spliced into the live tree, `insertImportedNodes` walks every fragment node's `classIds` and, for each name:
   - links to an **existing** class of that name if one exists (so `class="hero"` reuses your `hero` class), or
   - **auto-creates** a bare (style-less) class for that name.
3. The node's `classIds` are rewritten to the resolved ids in the same `mutateActiveTreeAndSite` transaction (one undo step).

The result: imported markup renders its `class` attribute, the classes show up in the Selectors panel, and they are immediately styleable — by the user in the editor, or by the AI agent emitting a `<style>` block in the `insertHtml` payload (whose `.foo {}` rules pre-create the named classes **with** styles, so the link in step 2 finds them) or `applyCss` after the fact.

> Skipping this linking step is the bug that made HTML-authored styles silently never apply: names on `classIds` never matched the id-keyed registry, so the renderer dropped them. Regression-gated by `src/__tests__/agent/executor.test.ts`.

## CSS handling

The importer preserves CSS across two layers, both gated by `isEmittableProperty`:

- **Inline `style="…"`** → the node's `inlineStyles` bag (per-node `style=""` layer). Full declarations, not just backgrounds.
- **`<style>` blocks** → parsed by the consumer (`cssToStyleRules`) into registry `StyleRule`s shown in the Selectors panel. A `.foo {}` rule binds to nodes carrying `class="foo"`; ambient selectors (`body`, `a:hover`, `.a .b`) register globally. First-wins on name/selector collisions with existing rules.
- **Class names without a matching `<style>` rule** still survive — `insertImportedNodes` auto-creates a bare (style-less) class for the name (see [Class linking](#class-linking-name--id)), styleable afterwards in the editor or by the agent.

`importHtml` itself stays CSS-agnostic: it returns raw `styleCss` and the consumer (which has the site's breakpoints and may import `@core/siteImport`) does the parsing. This avoids an `htmlImport → siteImport` import cycle and lets `@media` fold into the site's real breakpoints.

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Calling `walkAndMap` before `stripUnsafe` | Call `importHtml(source)` — it runs both in the correct order |
| Importing `parseHtml` or `walkAndMap` from inside `src/core/` via a deep path | Import through the barrel: `import { importHtml } from '@core/htmlImport'` |
| Adding a server-side DOM import to `parseHtml.ts` | If server-side parsing is needed, add a guarded dynamic import at the call site — `parseHtml.ts` must stay importable in the browser bundle without bundling a DOM library |
| Storing `alt` text on `base.image` nodes produced by the importer | `base.image` has no `alt` prop; alt lives on the media library asset |

---

## Related

- [docs/features/modules.md](modules.md) — module definitions, `base.text`, `base.button`, `base.image`, `base.container`
- [docs/features/agent.md](agent.md) — AI agent feature; `insertHtml` and `replaceNodeHtml` run through this pipeline
- [docs/reference/page-tree.md](../reference/page-tree.md) — `NodeTree<PageNode>`, `createNode`, `ImportFragment` shape
- Source-of-truth files:
  - `src/core/htmlImport/index.ts` — public barrel + API documentation
  - `src/core/htmlImport/rules.ts` — `HTML_TO_MODULE_RULES` mapping table
  - `src/core/htmlImport/walkAndMap.ts` — `importHtml()`, `walkAndMap()`, `ImportResult`, `ImportFragment`
  - `src/core/htmlImport/stripUnsafe.ts` — `stripUnsafe()`, `StripReport`
  - `src/admin/modals/ImportHtml/ImportHtmlModal.tsx` — paste-HTML modal
  - `src/admin/spotlight/commands/importHtml.ts` — Spotlight command
- Gate tests:
  - `src/__tests__/htmlImport/mapping.test.ts` — 95 per-rule mapping tests
