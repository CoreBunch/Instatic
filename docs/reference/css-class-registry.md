# Style Rule Registry (formerly CSS Class Registry)

The site's style rule registry — `Record<string, StyleRule>` stored on the site shell (`site.styleRules`). Every user-defined CSS rule lives here. The publisher compiles entries to CSS at publish time; the editor's canvas injects the same CSS for live preview.

Two kinds of rules:

1. **Author-facing class rules** (`kind: 'class'`) — the user picks a name (`hero-button`, `card-meta`) and the editor applies them via `node.classIds`. Selector is `.<name>`.
2. **Ambient rules** (`kind: 'ambient'`) — attach by CSS selector matching, not by node assignment (e.g. `h1`, `.hero .title`, `a:hover`). The publisher emits the rule but never writes to `class=` attributes. Supported stylesheet-level imports such as `@keyframes` are stored as ambient rules with `rawCss`.
3. **Scoped classes** — generated class-kind rules owned by a single node (for "set this property only on this element"). The scope object pins the rule to its node.

---

## TL;DR

- Stored on `SiteShell.styleRules: Record<string, StyleRule>`.
- Source-of-truth schema: `StyleRuleSchema` in `src/core/page-tree/styleRule.ts`.
- Compiled to CSS by `classCss.ts` in the publisher; collected via `collectClassCSS(site)`.
- Each node references class-kind rules by id (`node.classIds: string[]`). Later ids in the array win in cascade order.
- Selector UI surfaces display the rule's CSS selector (`styleRuleSelector(rule)`): class-kind rules appear as `.<name>`, ambient rules appear as their verbatim `selector` text.
- Rule **name** is the class token for class-kind rules. For ambient rules, `selector` is the source of truth; user edits keep `name` aligned to the selector so old class-name-only UI paths cannot add an extra dot.
- Rule **id** is the stable internal identifier (`<nanoid>`).
- Scoped rules (`scope: { type: 'node', nodeId, role: 'module-style' }`) are pinned to one node.
- Generated rules (framework-emitted spacing utilities, etc.) are flagged on `generated` so the Properties panel selector picker can filter them out by default.

---

## The `StyleRule` shape

```ts
interface StyleRule {
  id:           string                              // nanoid, stable across renames
  name:         string                              // class token for class rules; selector mirror for ambient rules
  kind:         'class' | 'ambient'                // discriminator
  selector:     string                              // CSS selector (e.g. '.hero-button' or 'h1 > span')
  order:        number                              // cascade order; rules sorted ascending by this
  description?: string
  scope?: {
    type:   'node'
    nodeId: string
    role:   'module-style'
  }
  styles:           Record<string, unknown>          // base CSS properties (CSSPropertyBag-shaped at write time)
  contextStyles:     Record<string, Record<string, unknown>>  // per-context overrides, keyed by context id
  rawCss?:          string                            // supported raw at-rule CSS, currently imported @keyframes
  generated?:    GeneratedClassMetadata               // framework-generated flags
  createdAt?:   number
  updatedAt?:   number
}
```

`contextStyles` is the **unified editing-context map**. Each key is a *context id* that is **either**:

- a **viewport context id** (from `site.breakpoints`) → the publisher emits the context's configured `@media` query; **or**
- a **custom condition id** (from `site.conditions`, the reusable `@media`/`@container`/`@supports` registry) → the publisher emits that condition's `@`-prelude.

`parseStyleRule` reads only the current `contextStyles` shape. Obsolete per-rule context fields are ignored rather than migrated.

`styles` and `contextStyles` are typed `Record<string, unknown>` at the persistence boundary — narrowing happens at the publisher's `bagToCSS` (`classCss.ts`). The WRITE API (class slice, framework generators) uses the typed `CSSPropertyBag` shape from `src/core/page-tree/cssPropertyBag.ts`.

`rawCss` is intentionally narrow. The importer uses it for sanitised `@keyframes` blocks that cannot be represented as selector declarations; the publisher emits only supported raw keyframes after its own safety gate. General arbitrary CSS strings still belong in structured `styles` / `contextStyles` entries.

---

## Naming

Class-kind rule **name** is the public class token. It is stored without the leading dot; selector-facing UI renders it through `styleRuleSelector(rule)`, so users see `.hero-button` while node `class=` output stays `hero-button`. `assertValidCssClassName(name)` enforces:

- Required, after trimming at creation/rename boundaries
- No leading, trailing, or embedded ASCII whitespace
- No control characters

The selector itself is produced by `classKindSelector(name)`, which escapes the token for CSS when needed. Ambient rule **name** mirrors the ambient selector after user edits so older class-name-only surfaces cannot accidentally render an extra leading dot.

Rule **id** is internal (a nanoid). Refs from nodes (`classIds`) and from internal data structures use the id, not the name. This means renaming a rule doesn't break anything that references it.

Plugin-shipped rules are namespaced under the plugin id: `acme.template/hero-root`. See [docs/features/plugin-system.md](../features/plugin-system.md) (the pack section).

---

## Assigning class rules to nodes

```ts
interface PageNode {
  // ...
  classIds: string[]    // ordered; later ids win in CSS cascade
}
```

Only `kind: 'class'` rules are assigned via `classIds`. Ambient rules (`kind: 'ambient'`) attach by CSS matching and never appear in `classIds`.

The right Properties Panel exposes this through a unified selector picker:

- assigned class-kind rules appear as removable `TagPill` chips and add / remove entries from `node.classIds`;
- matching ambient rules appear as non-removable `TagPill` chips because they affect the selected element through CSS matching — but only when at least one selector-list entry targets the element **specifically** (its subject compound contains a type, class, id, or attribute simple selector). Rules that match solely through a universal subject (`*`, `body.x *`, `*::before`) style every element in their scope; they are page-wide plumbing — resets — not an identity of the selected element, so they never pill. They remain editable through the dropdown (enabled) and the Selectors panel;
- ambient rules whose selector contains a supported state pseudo-class (`:hover`, `:focus`, `:checked`, etc.) but whose stripped base selector matches the selected element appear as **inactive-pseudo** pills — they are surfaced even though `element.matches()` reports false for the full selector, so state styles stay editable without physically triggering the state;
- non-matching ambient rules (those whose stripped base selector also fails) still appear in the dropdown, disabled with a "doesn't match this element" reason;
- all pills are sorted **weakest → strongest by CSS specificity** (then by `rule.order`) so the chip that actually wins the cascade reads last;
- class-kind pills and suggestion rows show the leading dot (`.hero-button`) because they are CSS selectors, not plain labels.
- selector creation uses one input path. `classifySelectorCreateInput` treats one class token (`hero-button` or `.hero-button`) as a class-kind rule and selector-shaped input (`h1`, `.hero .title`, `a:hover`) as an ambient rule.
- invalid selector-shaped input is validated in the picker autocomplete, disables submit, and replaces the "Create selector" row with a warning row. The store repeats the same validation as the final guard.
- creating an ambient selector from the picker always creates the rule. If it does not match the selected element, the picker leaves selector-editing mode alone and shows an inline "added but does not match this element" notice with an Undo button.

The picker decides ambient matches via `element.matches(selector)` on the selected live canvas element. A selector such as `.hero .title` appears when the selected element is `.title`, not when the selected element is the `.hero` ancestor.

The live element is resolved by `findRenderedCanvasNodeElement` (`src/admin/pages/site/canvas/canvasNodeLookup.ts`), which searches ONLY the per-breakpoint canvas iframe documents (identified by `data-breakpoint-id` on their `<body>`). It must never query the admin document: the DOM panel's tree rows, the Import-HTML preview rows, and the selection/hover overlay rings all carry `data-node-id` there, and whether they exist depends on transient UI state (the layers tree auto-expands the selected node's ancestors *after* selection) — matching against them made ambient pills appear and disappear between clicks of the same node.

**Pseudo-state rules.** Ambient selectors that carry a supported state pseudo-class are recognized as state rules. The supported set (`SUPPORTED_PSEUDO_STATES`) covers transient interaction, navigation, and form-state pseudo-classes: `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within`, `:target`, `:visited`, `:checked`, `:indeterminate`, `:placeholder-shown`, `:autofill`, `:disabled`, `:valid`, `:invalid`, `:in-range`, `:out-of-range`, `:user-valid`, `:user-invalid`. Structural and attribute-condition pseudos (`:first-child`, `:required`, `:not(...)`, etc.) are intentionally absent — `element.matches()` evaluates those correctly against the static DOM, so they produce direct matches, not inactive-pseudo matches. All shared helpers live in `src/admin/pages/site/cssStatePseudo.ts` (`SUPPORTED_PSEUDO_STATES`, `selectorStatePseudo`, `stripStatePseudos`, `splitSelectorList`).

State pseudo matching is tested per selector list entry: `.btn:hover, .x .btn` is split on the top-level comma and each entry is stripped independently. Pseudo-elements (e.g. `::after` in `.card:hover::after`) are stripped because `element.matches` never matches a pseudo-element.

**Forced state preview.** When a state-pseudo ambient rule is the active rule in the Properties Panel, the canvas cannot toggle the real `:hover`/`:focus`/… state via the DOM, so `ClassStyleInjector` force-paints the rule's declarations directly onto the selected node via a doubled `[data-node-id]` selector rule emitted into a separate `<style id="mc-classes-force-state">` element. This mirrors the full `contextStyles` emission — an override that only applies at a breakpoint is previewed only in that breakpoint's frame. When a property control is being dragged (in-flight edit), the forced preview overlays the edit live so dragging a slider shows the correct state appearance.

Class order matters — drag-reorder is supported for assigned class pills.

At render time, `classNamesForClassIds(classIds, registry)` returns the rendered class names that go onto the element's `class=` attribute. `injectNodeClassIds(html, node, site)` in the publisher splices them into the root tag.

When the user selects a rule from the Selectors Panel, the Properties Panel enters **selector-editing mode** — the panel body shows style controls for that rule instead of a page node. The panel header renders `SelectorHeader`, which displays the rule's CSS selector and a usage badge (`resolveSelectorUsage` → `{ label: string | null }`; `null` renders no badge). For non-generated, non-locked rules, the header also provides inline rename and delete actions. `DeleteSelectorDialog` repeats the usage string so the user understands the impact before confirming. Both actions are gated by `canEditStyle && !isGeneratedClassLocked(cls)`.

---

## Selectors Panel

The Selectors Panel (`src/admin/pages/site/panels/SelectorsPanel/SelectorsPanel.tsx`) is the global style rule browser. It lists every rule that passes `isUserVisibleClass` (user-defined and framework-generated; scoped instance rules are excluded).

**Filter bar — four tabs:**

| Tab     | Shows                                                          |
|---------|----------------------------------------------------------------|
| All     | All reusable rules                                             |
| User    | Rules where `!isGeneratedClass(cls)`                           |
| Utility | Rules where `isGeneratedClass(cls)`                            |
| Unused  | Rules where `resolveSelectorUsage(...).unused === true`         |

**Search** (`normalizeSelectorQuery` + `selectorMatchesQuery`) matches against:
1. The rule's selector token (name or ambient selector text).
2. All declared CSS property names (`font-size`, `background-color`).
3. `name:value` pairs (`font-size:16px`) across base styles and every context override.

Searching `font-size: 16px` (with or without the space) matches only rules with that exact declaration — not just by name.

**Usage badges:** each row receives `usage: string | null` from `resolveSelectorUsage`. `null` renders no badge. Class rules show the exact reference count (`"Used 2 times"`, `"Unused"`); ambient rules show `"Unused"` only when provably dead (see **Usage tracking** below), `null` otherwise.

**Multi-select:** clicking a row's checkbox enters multi-select mode. The Properties Panel switches to the bulk inspector (`MultiSelectorInspector`), which exposes Apply-to-element, Duplicate, and Delete. "Select all" selects every row passing the current filter, not the whole registry.

**Rendering:** rows are mounted in batches of 100 (`SELECTOR_PAGE_SIZE`). An `IntersectionObserver` on a tail sentinel reveals the next batch as the user scrolls. `useDeferredValue` defers the real rows by one commit so a skeleton appears instantly on panel open.

---

## Usage tracking

All usage logic lives in `src/admin/pages/site/panels/selectorUsage.ts`.

**Class rules** are referenced via `node.classIds`, so the count is exact. `buildSelectorUsageMap(site)` makes a single O(pages × nodes) pass over every `page.nodes`, tallying each `classId` in one `Map<classId, count>`. Classes with zero references are absent (callers default to 0). This map is shared between the Selectors Panel and `usePropertiesPanelData` — the cost is paid once per render.

**Ambient rules** are not referenced in `classIds`; they match elements by CSS selector. Their per-id count is always 0, which made every ambient row show a misleading "Unused". The panel now uses a conservative heuristic: a rule is only claimed unused when provably dead — when EVERY comma-separated group is anchored on a class token that no node uses.

`buildClassTokenUsageMap(classes, usageById)` maps each class-kind rule's `.name` selector token to its node count. `isAmbientSelectorProvablyDead(cls, classTokenUsage)` splits the ambient selector on commas and tests each group: it extracts class tokens (`.foo`, `.nav-links`), looks them up in the token map, and returns `true` only if at least one class token in EVERY group has count 0. Groups with no evaluable class token (tag-only, `*`, `:nth-child`, unknown tokens) are treated as possibly-live — the function never claims a false "Unused".

`resolveSelectorUsage(cls, usageById, classTokenUsage)` → `SelectorUsage { label: string | null; unused: boolean }`:

- **Class rule**: `label = formatSelectorUsage(count)` (`"Unused"` / `"Used 1 time"` / `"Used N times"`); `unused = count === 0`.
- **Ambient rule**: provably dead → `{ label: 'Unused', unused: true }`; otherwise → `{ label: null, unused: false }`.

`label: null` is the explicit "no badge" signal — the usage cannot be assessed accurately, not that the rule is live.

---

## Compiling rules to CSS

`collectClassCSS(site)` walks the style rule registry and emits CSS for each entry. Rules are sorted by `order` ascending so later, more-specific overrides appear later in source and win on equal specificity.

```text
For each rule in registry (sorted by order):
  selector = rule.selector               // e.g. '.hero-button' or 'h1 > span'
  base CSS  = bagToCSS(rule.styles)
  emit:     '${selector} { ${base CSS} }'

  for each (contextId, bag) in rule.contextStyles:
    if contextId is a custom condition (site.conditions):  // emitted first
      prelude = '@media <query>' | '@container [name] (<query>)' | '@supports (<query>)'
    else if contextId is a viewport context (site.breakpoints):  // emitted after, media-query sorted
      prelude = '@media ${breakpoint.mediaQuery ?? `(max-width: ${width}px)`}'
    else:  // orphaned key — skipped
      continue
    emit: '${prelude} { ${selector} { ${bagToCSS(bag)} } }'
```

Cascade order within a rule: base → custom conditions (registry order) → viewport contexts. Pure max-width contexts emit widest first so narrower queries win; pure min-width contexts emit narrowest first so wider queries win; mixed/custom viewport queries keep registry order.

The compiled string is part of the per-page CSS bundle (see [docs/features/publisher.md](../features/publisher.md) → CSS pipeline).

### `bagToCSS`

Translates the property bag (`{ color: '#fff', padding: { top: 16, right: 8 } }`) to CSS strings. Handles:

- Plain values: `color: #fff;`
- Spacing bags: `padding: 16px 8px 0 0;` (decomposed)
- Variable references: `color: var(--site-primary);`
- Multi-value props (transforms, transitions): joined per CSS rules

Invalid entries are silently dropped — the bag is tolerant.

---

## Scoped rules

A scoped rule is **owned by one node**. Its scope object pins it to that node's id and a role:

```ts
{
  id:    'class-abc',
  name:  '__instatic_scope_<nodeId>',          // generated, never user-facing
  kind:  'class',
  selector: '.__instatic_scope_<nodeId>',
  order: 0,
  scope: { type: 'node', nodeId: 'node-xyz', role: 'module-style' },
  styles: { 'border-radius': '12px' },
}
```

When the publisher emits the selector, it generates a uniquely-prefixed name so it can't be applied accidentally elsewhere:

```css
[data-node-id="node-xyz"].__instatic_scope_node-xyz {
  border-radius: 12px;
}
```

Use scoped rules when you want **per-node styling** without polluting the global class palette. The Properties Panel exposes this via "Edit only this element" controls.

### Duplicating nodes with scoped rules

When a node is duplicated, its scoped rules need fresh ids that point at the duplicated nodes (not the originals). `cloneScopedClassesForNodeMap(scopedRules, oldToNewIdMap)` rewrites them in one pass.

Called by `duplicateNode` and `pasteSubtree` in `src/core/page-tree/mutations.ts`.

---

## Generated rules (framework + plugin)

A "generated" rule is one the codebase emits programmatically — typically the spacing scale utilities (`.pad-1`, `.pad-2`, ...) or the typography scale. They have `generated.origin === 'framework'` with family/step tags.

`classUtils.ts`:

```ts
isUserVisibleClass(cls)        // false for generated rules — hides them from the selector picker by default
isGeneratedClass(cls)          // true if `generated.origin === 'framework'`
isGeneratedClassLocked(cls)    // true if the rule is locked from manual edit (the framework owns its styles)
generatedClassKindLabel(cls)   // e.g. 'Spacing', 'Typography' — for grouping in selector-picker rows
```

The framework regenerates these rules whenever the user changes the framework scale (Site → Framework → Scale panel). Users can opt to show them in the selector picker via Settings → Editor → Show framework-generated classes.

---

## Tolerant parse

`parseStyleRule(raw)` is tolerant — it never throws. Invalid `scope` shapes drop silently; missing `styles` falls back to `{}`; missing `id` or `name` makes the whole entry skip. `parseStyleRuleRegistry(raw)` walks an entire registry and filters out invalid entries.

This is what makes the editor robust against partially-corrupt persisted data — a single broken rule doesn't break the whole site load.

The tolerant parser also backfills `kind`, `selector`, and `order` on old persisted shells that predate the selectors system.

Hard parsing (throws on shape mismatch) uses `Value.Parse(StyleRuleSchema, raw)` directly. The persistence layer uses the tolerant path so the editor can render even with garbage entries.

---

## Cookbook

### Create a class-kind rule

```ts
import type { StyleRule } from '@core/page-tree'
import { classKindSelector } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'

const name = 'hero-button'
const rule = useEditorStore.getState().createClass(name, {
  'background-color': 'var(--site-primary)',
  'padding':          { top: 12, right: 24, bottom: 12, left: 24 },
  'border-radius':    '8px',
})

// Equivalent persisted shape:
const persistedRule: StyleRule = {
  id:       rule.id,
  name,
  kind:     'class',
  selector: classKindSelector(name),
  order:    rule.order,
  styles: {
    'background-color': 'var(--site-primary)',
    'padding':          { top: 12, right: 24, bottom: 12, left: 24 },
    'border-radius':    '8px',
  },
  contextStyles: {},
}
```

The rule is added to `site.styleRules`. The publisher emits CSS for it on next publish.

### Assign a class rule to a node

```ts
const rule = useEditorStore.getState().createClass('hero-button')
useEditorStore.getState().setNodeClassIds(nodeId, [rule.id])
```

The class names appear on the rendered element via `classNamesForClassIds`.

### Per-context styles (viewport contexts + custom conditions)

```ts
{
  id:    'card',
  name:  'card',
  kind:  'class',
  selector: '.card',
  order: 0,
  styles:        { padding: 16, 'border-radius': 8 },
  contextStyles: {
    mobile:  { padding: 8 },                       // viewport context id
    desktop: { padding: 24 },                      // viewport context id
    'media:(orientation: landscape)': { padding: 12 },  // custom condition id (site.conditions)
  },
}
```

The publisher wraps each viewport context block in that context's configured media query. Custom conditions use their stored `@media`/`@container`/`@supports` prelude.

### Scoped rule for one node

The Properties Panel's "Custom" tab generates a scoped rule automatically when the user sets a property only on that node. Internally:

```ts
const name = `__instatic_scope_${nodeId}`
const scoped: StyleRule = {
  id:       nanoid(),
  name,
  kind:     'class',
  selector: classKindSelector(name),
  order:    0,
  scope: { type: 'node', nodeId, role: 'module-style' },
  styles: { 'border-radius': '12px' },
}
useEditorStore.getState().createClass(scoped)
useEditorStore.getState().setNodeClassIds(nodeId, [...existing, scoped.id])
```

The user never sees `__instatic_scope_<nodeId>` — the panel shows it as "Custom styles".

### Rename a class rule

Rule **id** is stable. Renaming is handled by `renameStyleRule` in `src/admin/pages/site/store/styleRuleRename.ts`, which the store wires up via `classSlice.renameClass`. Behavior differs by kind:

- **class-kind**: `assertValidCssClassName` validates the new name, then `name` is updated and `selector` is rebuilt from it via `classKindSelector`. Uniqueness against other class-kind rules is enforced.
- **ambient**: `isValidCssSelector` validates the new selector text, then both `name` and `selector` are updated to the trimmed selector string. Uniqueness is not required (multiple ambient rules can share a selector).

Nodes that reference the rule by id keep working — only the rendered CSS output changes.

### Delete a rule

`useEditorStore.getState().deleteClass(classId)`:

1. Remove the entry from `site.styleRules`.
2. Walk every node and remove the id from `classIds`.
3. (Optional) If the rule is scoped to a now-deleted node, the rule can be GC'd alongside.

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| Storing CSS strings directly on nodes                                | Add a `StyleRule` to the registry; reference via `classIds` |
| Looking up a rule by name                                           | Look up by id — names can be renamed                     |
| Hand-emitting CSS in module `render`                                 | Add a rule to the registry — modules emit shared CSS, not per-instance overrides |
| Forgetting to clone scoped rules on duplicate / paste              | `cloneScopedClassesForNodeMap` — called by mutations     |
| Naming a user class `__instatic_scope_*`                                   | Internal scoped rules use this prefix; keep user-created names free of it (the class-kind validator does not reject the prefix — it's a convention, not a gate) |
| Mixing user rules and framework rules in the same `classIds` array without intent | The order matters — later wins. Framework rules are usually last (override semantics). |
| Reading `rule.styles` as `CSSPropertyBag` without narrowing         | The persistence boundary stores `Record<string, unknown>` — narrow via `bagToCSS` or `parseStylesBag` |
| Hard-failing the editor on a corrupt rule entry                     | `parseStyleRuleRegistry` is tolerant — invalid entries drop silently |
| Assigning an ambient rule to `node.classIds`                        | Ambient rules attach by selector matching — only `kind: 'class'` rules go in `classIds` |

---

## Related

- [docs/features/publisher.md](../features/publisher.md) — `collectClassCSS` in the CSS pipeline
- [docs/features/site-shell.md](../features/site-shell.md) — `Record<string, StyleRule>` on the shell
- [docs/reference/page-tree.md](page-tree.md) — `node.classIds`
- [docs/design.md](../design.md) — design rules around user classes
- Source-of-truth files:
  - `src/core/page-tree/styleRule.ts` — `StyleRuleSchema`, `parseStyleRule`, `parseStyleRuleRegistry`
  - `src/core/page-tree/classNames.ts` — `styleRuleSelector`, `classNamesForClassIds`, `assertValidCssClassName`
  - `src/core/page-tree/classUtils.ts` — `isUserVisibleClass`, `isGeneratedClass`, ...
  - `src/core/page-tree/cssPropertyBag.ts` — `CSSPropertyBag` type
  - `src/core/page-tree/scopedClassClone.ts` — `cloneScopedClassesForNodeMap`
  - `src/core/publisher/classCss.ts` — `bagToCSS`, `generateClassCSS`, `createStyleRuleCssEmitter` (the single rule-emission engine shared by publish and canvas)
  - `src/core/publisher/cssCollector.ts` — `collectClassCSS`
  - `src/admin/pages/site/cssStatePseudo.ts` — `SUPPORTED_PSEUDO_STATES`, `selectorStatePseudo`, `stripStatePseudos`, `splitSelectorList`; shared helpers for reasoning about state pseudo-classes in the editor
  - `src/admin/pages/site/panels/PropertiesPanel/selectorPickerModel.ts` — `deriveSelectorPickerModel`, `SelectorMatch`, `SelectorPillItem`, `SelectorSuggestionItem`; pure derivation layer for the unified selector picker including specificity sorting and inactive-pseudo logic
  - `src/admin/pages/site/canvas/canvasClassCss.ts` — `generateCanvasClassCSS`, `generatePreviewClassCSS`, `generateForcedStateCSS`; thin canvas wrappers over the publisher's `generateClassCSS` / `createStyleRuleCssEmitter` (reset + fonts + framework preamble, forced-state selectors, identity memo)
  - `src/admin/pages/site/canvas/ClassStyleInjector.tsx` — manages three `<style>` elements per iframe: `mc-classes`, `mc-classes-preview`, `mc-classes-force-state`
  - `src/core/page-tree/styleRule.ts` — `classifySelectorCreateInput`; the shared classifier for selector creation surfaces
  - `src/admin/pages/site/store/styleRuleRename.ts` — `renameStyleRule`, `isValidCssSelector`; rename logic for both class-kind and ambient rules
  - `src/admin/pages/site/panels/PropertiesPanel/ClassPicker.tsx` — picker UI entry point: pill strip, input, creation flow
  - `src/admin/pages/site/panels/PropertiesPanel/classPickerUiState.ts` — reducer + action types for the picker's UI state
  - `src/admin/pages/site/panels/PropertiesPanel/useClassPickerDerivedState.ts` — derives selector model, suggestions, and keyboard-nav indices
  - `src/admin/pages/site/panels/PropertiesPanel/ClassPillContextMenu.tsx` — context menu portal for class pill right-click / keyboard-menu actions
  - `src/admin/pages/site/panels/PropertiesPanel/ClassRenameDialog.tsx` — rename dialog for class selectors
  - `src/admin/pages/site/panels/PropertiesPanel/SelectorHeader.tsx` — selector name, inline rename, delete, and usage badge shown in the Properties Panel header during selector-editing mode
  - `src/admin/pages/site/panels/SelectorDialogs.tsx` — `SelectorNameDialog`, `DeleteSelectorDialog`; shared dialog components for selector editing surfaces
  - `src/admin/pages/site/panels/SelectorsPanel/SelectorContextMenu.tsx` — right-click context menu for selector rows
  - `src/admin/pages/site/panels/selectorUsage.ts` — `buildSelectorUsageMap`, `buildClassTokenUsageMap`, `resolveSelectorUsage`, `isAmbientSelectorProvablyDead`, `formatSelectorUsage`, `normalizeSelectorQuery`, `selectorMatchesQuery`, `getSelectorStyleSummary`; all usage tracking and search logic for the Selectors Panel
- Gate tests:
  - `src/__tests__/architecture/framework-typography-spacing.test.ts`
  - `src/__tests__/architecture/task427-preview-class-css.test.ts`
