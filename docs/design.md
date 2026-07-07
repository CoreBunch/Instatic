# Design

The visual design system for Instatic — principles, tokens, surfaces, components.

The design is a **two-layer color model**: an achromatic base (surfaces, borders, default text) with a deliberate semantic and categorical color layer on top (numbered accents for identity, state tokens for meaning, canvas neon for selection). Everything is tokenized in `src/styles/globals.css`. Every primitive lives in `src/ui/components/`.

---

## TL;DR

- **Base is achromatic; color is the layer on top.** Surfaces, borders, and default text are neutral. Color is used to convey **identity** (`--accent-1..10`) and **state** (danger, warning, success, info, canvas selection / hover). Color is never decorative — every colored pixel carries meaning.
- **Borderless tile cards.** Dashboard widgets and equivalent surfaces sit on a darker parent (`--bg-surface`) with a 1px grid gap, no border, `--card-radius` (16px). The gap reveals the parent and reads as a divider. Hover lifts the surface tone, never the border. Canonical implementation: `src/ui/components/Widget/Widget.module.css`.
- **Bordered transparent inputs.** Inputs have a 1px white-alpha border, transparent background, and a pill 1em radius. Focus adds an inset achromatic glow.
- **Floating overlay panels.** Spotlight, popovers, and modals use direct globals: `--bg-surface`, `--overlay-10`, `--panel-radius`, `--panel-blur`, and `--shadow-panel`.
- **Editor controls** (toolbar buttons, chips) use `--radius` (6px) for default and `--radius-sm` (3px) for tight badges.
- **Admin appearance is token-scoped.** Settings → Preferences stores `theme`, `density`, and `textScale` in `instatic-editor-prefs`; `useEditorAppearancePreferences()` mirrors them to `data-editor-theme`, `data-editor-density`, and `data-editor-text-scale` on the document and layout roots. Light mode and text scaling are token overrides, not per-component restyles.
- **One source of truth: `src/styles/globals.css`.** No hardcoded hex / rgb / hsl in admin / ui CSS modules — gated by `css-token-policy.test.ts`. Admin font sizes use the fluid `--text-*` scale, and admin spacing uses the fluid `--space-*` scale — gated by `admin-typography-token-policy.test.ts` and `admin-spacing-token-policy.test.ts`.
- **CSS Modules only.** No Tailwind utility classes — gated by `noTailwindUtilities.test.ts`. No Tailwind ecosystem deps — gated by `no-tailwind-deps.test.ts`.
- **Every interactive control goes through a UI primitive** from `src/ui/components/`. Bare `<button>` is gated.
- **Icons come from `pixel-art-icons`.** Deep-imported for tree-shaking. No `lucide-react`, no inline SVG strings.

---

## Principles

### 1. The base disappears, the meaning appears

The chrome is neutral and quiet so the user's content and the system's signals are the only things competing for attention. The default theme is dark; the light theme swaps the achromatic base tokens and remaps identity accents to foreground-safe variants while preserving the same hierarchy. Surfaces, borders, default text — all achromatic. Color is reserved for things that mean something: a green dot says "saved", a peach widget header says "this card is about posts", a neon ring says "the canvas selected this node".

If a color isn't carrying information, it doesn't belong in the chrome.

### 2. Two layers, sharp separation

```text
┌────────────────────────────────────────────────────────────────┐
│  Layer 2 — SEMANTIC + CATEGORICAL COLOR                        │
│  numbered identity accents, state (danger/warning/               │
│  success/info), canvas neon (selection/hover)                  │
├────────────────────────────────────────────────────────────────┤
│  Layer 1 — ACHROMATIC BASE                                     │
│  --bg-body / --bg-surface / --bg-surface-2..5                    │
│  --text-bright / --text / --text-muted / --text-subtle           │
│  --border / --border-muted / --overlay-*                         │
└────────────────────────────────────────────────────────────────┘
```

Both layers are tokenized. Layer 1 is the base every primitive paints itself with. Layer 2 is added by the primitive when there's a reason — a tint dot on a widget title, a colored row on a panel rail, a status pill, a focus ring on the canvas.

### 3. Surfaces have a hierarchy

The base layer uses six surface tones to convey depth without shadows or gradients on inline content. Lighter surfaces are higher in the stack:

```text
--bg-body          #000000   ← page bottom (root, behind everything)
--bg-surface     #1b1b1b   ← darker parent of tile cards / sidebar fill
--bg-surface-2   #282828   ← tile cards themselves, panel bodies
--bg-surface-3   #323232   ← tile/card hover, nested structural surfaces
--bg-surface-4   #4a4a4a   ← stronger nested structural surface
--bg-surface-5   #605f5f   ← strongest nested structural surface
```

Tile/card hovers change **tone**, not border. Compact interactive chrome — buttons, segmented controls, toolbar chips, selected rows, and pressed states — uses the foreground overlay scale (`--overlay-5/10/20/30`) instead of surface steps so the same state hierarchy has enough contrast in both dark and light themes.

### 4. Cards are tiles, not boxes

The dashboard pattern — and any surface that wants to read as a unit — is a **borderless tile** sitting on a darker parent with a 1px grid gap. The gap reveals the parent and visually separates the cards without a stroke. The card has no border, just a background and a 16px radius. Hover lifts the surface, never the edge.

```text
Parent surface  ── --bg-surface
                   ┌──────────┐ ┌──────────┐ ┌──────────┐
                   │  tile 1  │ │  tile 2  │ │  tile 3  │   ← --bg-surface-2
                   └──────────┘ └──────────┘ └──────────┘
                   ▲           ▲           ▲
                   └────── 1px grid gap ───┘
                   (no border, just a sliver of the parent showing through)
```

This is implemented by `Widget` (`src/ui/components/Widget/`) and `DashboardGrid` (`src/admin/pages/dashboard/components/DashboardGrid.module.css`). Use the same pattern for any equivalent tile surface.

### 5. Inputs wear their borders. Cards don't.

Inputs are the inverse of cards: transparent background with a 1px white-alpha border. Pill radius (1em ≈ 16px). On focus, an inset achromatic glow appears. The border is what defines the input; no fill.

This split (cards = filled & borderless, inputs = unfilled & bordered) is the load-bearing visual distinction between containers and controls.

### 6. Identity is a color, not a label

Categories of things have an associated color drawn from the numbered **accent** scale. Each widget category has a tint; each panel rail icon has a tint; each storage breakdown segment has a tint. Color is the at-a-glance label that lets the eye sort the screen.

| Token              | Hex       | Role                                                    |
|--------------------|-----------|---------------------------------------------------------|
| `--accent-1` | `#8ee6c8` | "Saved / system / status" categories                    |
| `--accent-2`| `#c8b6ff` | "Pages / structure" categories                          |
| `--accent-3`  | `#9bdcff` | "Storage / data / configuration" categories             |
| `--accent-4`| `#ffc7a8` | "Posts / media / activity" categories                   |
| `--accent-5` | `#ffb6cd` | Secondary warm identity tint                          |
| `--accent-6` | `#b8f28b` | Secondary green identity tint                         |
| `--accent-7` | `#f7df72` | Secondary yellow identity tint                        |
| `--accent-8` | `#83e7ff` | Secondary blue identity tint                          |
| `--accent-9` | `#f0a6ff` | Secondary violet identity tint                      |
| `--accent-10` | `#ff9f9f` | Secondary red identity tint                          |

Accent tokens don't live in `src/styles/globals.css` to be decorative — they're part of the design system. Panel rails assign these accents automatically using `assignRailAccents` (multi-item surfaces, avoids repeats inside the visible group) or `railAccent` (single item) from `src/ui/railAccent.ts`. Primitives like `Widget` can still accept an explicit tint when the category is product-defined. The light theme overrides the same accent names with darker foreground colors so rail icons and badges keep contrast on white surfaces. New identity colors are added by extending the `--accent-*` group, not by inlining a color.

### 7. The canvas owns its own palette

The canvas — where the user's page renders — has three chromatic rings used purely as affordance:

- `--canvas-selection-ring` (neon green `#39ff14`) — node selected by the user
- `--canvas-hover-ring` (neon pink `#ff2bd6`) — node hovered
- `--canvas-selector-ring` (neon orange `#ff8800`) — match sweep when hovering a selector rule in the Selectors panel

These are bright on purpose so they read against any user content, including content that itself uses the chrome palette.

A shared diagonal-stripe placeholder (`--canvas-placeholder-bg`) marks empty modules across every block type — image, video, content, loop, container, slot-outlet, VC reference. Edit once, retune everywhere.

### 8. Motion respects the reader

Animations are short, purposeful, and never block content. The `@media (prefers-reduced-motion: reduce)` rule in `globals.css` zeroes animation and transition durations and disables smooth scroll for users who opt out. This is a non-negotiable accessibility floor (Constraint #189), not a polish item.

---

## Tokens

All tokens live in `src/styles/globals.css`. Anywhere you need a color, radius, shadow, font, spacing value, or z-index, use a token. If the right token doesn't exist, **add one to `globals.css`** — never inline a value.

### Color tokens

```text
Base surfaces (achromatic):
  --bg-body, --bg-surface-3
  --bg-surface, --bg-surface-2..5
  --border, --border-muted
  --border-subtle
  --scrollbar-track, --scrollbar-thumb,
  --scrollbar-thumb-hover

Base text (achromatic):
  --text-bright, --text, --text-muted,
  --text-subtle, --text-disabled

Fluid admin typography scale:
  --text-3xs, --text-2xs, --text-xs, --text-s, --text-m,
  --text-l, --text-xl, --text-2xl, --text-3xl, --text-4xl,
  --text-5xl, --text-6xl, --text-7xl

Fluid admin spacing scale:
  --space-px, --space-4xs, --space-3xs, --space-2xs,
  --space-xs, --space-s, --space-m, --space-l, --space-xl,
  --space-2xl, --space-3xl, --space-4xl, --space-5xl,
  --space-6xl, --space-7xl, --space-8xl, --space-9xl,
  --space-10xl, --space-11xl, --space-12xl

Overlay scale (foreground alpha; white in dark theme, dark in light theme):
  --overlay, --overlay-5, --overlay-10, --overlay-20, --overlay-30,
  --overlay-40, --overlay-50, --overlay-60, --overlay-70, --overlay-80,
  --overlay-90

Identity accents (categorical identity layer):
  --accent-1, --accent-2, --accent-3, --accent-4,
  --accent-5, --accent-6, --accent-7, --accent-8,
  --accent-9, --accent-10

Semantic state (meaning layer):
  --danger, --danger-light, --danger-lighter,
  --danger-text, --danger-10, --danger-20
  --warning, --warning-text, --warning-10,
  --warning-30
  --success, --success-bright,
  --success-text, --success-text-muted, --success-10
  --info-text
  --accent-1-10 through --accent-10-10

Canvas (selection / hover affordances):
  --canvas-chrome-shadow           (shared shadow for canvas notch chrome)
  --canvas-selection-ring          (inset 1px neon green)
  --canvas-hover-ring              (inset 1px neon pink)
  --canvas-selection-ring-color    (bare colour for outline / border-color)
  --canvas-hover-ring-color
  --canvas-placeholder-bg          (diagonal-stripe pattern for empty modules)

Keycap (Kbd / ShortcutKeys — scoped to those primitives):
  --kbd-face-top, --kbd-face-bottom
  --kbd-face-top-hover, --kbd-face-bottom-hover
  --kbd-border, --kbd-text
  --kbd-highlight, --kbd-inner-shadow, --kbd-edge, --kbd-drop

Code editor (GitHub Dark inspired — used inside CodeMirror only):
  --syntax-keyword, --syntax-entity,
  --syntax-property, --syntax-variable,
  --syntax-string, --syntax-constant,
  --syntax-comment, --syntax-operator, --syntax-invalid

Charts:
  --chart-default-tint (= --accent-4)
  --chart-series-min / --chart-series-min-glow
  --chart-series-max / --chart-series-max-glow
  --chart-segment-empty, --chart-segment-empty-border
  --chart-track-bg
```

### Text tokens — meaning hierarchy

| Token                       | Hex       | Means                          |
|-----------------------------|-----------|--------------------------------|
| `--text-bright`      | `#f4f4f5` | Titles, headings, KPIs         |
| `--text`             | `#ededed` | Primary body text              |
| `--text-muted`   | `#a1a1aa` | Labels, secondary UI           |
| `--text-subtle`       | `#787878` | Muted / placeholder            |
| `--text-disabled`      | `#52525b` | Disabled / very subtle         |

These five are the entire text palette. Add a new tone only by adding a new token.

### Typography tokens — fluid size scale

Admin UI font sizes use a Core Framework-style fluid scale: `--text-3xs` through `--text-7xl`. CSS Modules in `src/admin/` and `src/ui/` should set font sizes with `font-size: var(--text-s)` or the closest scale step, never a hardcoded pixel value. The ranges are intentionally narrow for dense admin chrome, with larger display steps reserved for page headings and KPI-style values.

These are admin tokens. The published-site Framework engine also emits short text-size tokens such as `--text-s`; that is a separate scope. Editor chrome injected into the canvas iframe maps admin sizes to `--chrome-text-*` before using them so it does not overwrite the site's Framework typography.

### Spacing tokens — fluid size scale

Admin UI spacing uses a Core Framework-style fluid scale: `--space-px`, then `--space-4xs` through `--space-12xl`. CSS Modules in `src/admin/` and `src/ui/` should use the scale for `margin`, `padding`, `gap`, `row-gap`, `column-gap`, and CSS-authored SVG dimensions, never a hardcoded pixel value. `--space-px` stays fixed for true 1px hairline gaps.

These are admin tokens. The published-site Framework engine also emits short spacing tokens such as `--space-s`; that is a separate scope. Editor chrome injected into the canvas iframe maps admin spacing to `--chrome-space-*` before using it so it does not overwrite the site's Framework spacing.

### Radius

| Token                | Value | Use                                                          |
|----------------------|-------|--------------------------------------------------------------|
| `--radius-sm` | 3px   | Tight chips, micro-badges, segmented control inner indicator |
| `--radius`    | 6px   | Default editor controls, toolbar buttons, ghost menu items   |
| `--panel-radius`     | 12px  | Floating overlay panels (Spotlight, modals, popovers)        |
| `--card-radius`      | 16px  | Borderless tile cards (Widget, dashboard cells, module inserter tiles) |
| `--input-radius`     | 1em   | Pill-shaped inputs, classes / property chips                 |
| `--tooltip-radius`   | 6px   | Tooltips                                                     |

Do not introduce ad-hoc radius values. Tile-card surfaces use `--card-radius`.

### Scrollbar chrome

Editor scrollbars are global chrome and stay achromatic. `globals.css` owns `--scrollbar-size`, `--scrollbar-radius`, `--scrollbar-track`, `--scrollbar-thumb`, and `--scrollbar-thumb-hover`; use those tokens for both `scrollbar-color` and `::-webkit-scrollbar` styling.

### Shadow and elevation

| Token                       | Use                                                     |
|-----------------------------|---------------------------------------------------------|
| `--focus-ring`       | Achromatic 1px focus ring (`0 0 0 1px var(--overlay-20)`) |
| `--shadow-panel`            | Composite for floating panels: bottom-inset shadow + drop shadow |
| `--shadow-panel-inset-bottom`| Sub-token: bottom inner shadow                         |
| `--shadow-panel-drop`       | Sub-token: drop shadow                                  |
| `--shadow-input-focus`      | Inset composite for focused inputs (achromatic glow)    |
| `--shadow-tooltip`          | Tooltip drop + inner highlight                          |

Use `--shadow-panel` directly when you need a floating-panel feel; don't recompose from the sub-tokens.

### Typography

```css
--font-sans: "Inter Variable", system-ui, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```

Type **sizes** are per-component and don't yet have a token scale. The patterns in actual use:

- Widget titles: 11px, weight 600, uppercase, letter-spacing 0.07em, color `--text-subtle`
- Widget KPI values: very large (~48–72px), weight 600, color `--text-bright`
- Body text: 13–14px, weight 400, color `--text`
- Captions / labels: 11–12px, weight 500, color `--text-muted`
- Monospace (paths, code chips): same size as surrounding text, `--font-mono`, often with `--bg-surface-3` background

If a size recurs across three or more primitives, promote it to a token.

### Z-index

```text
--z-dropdown:           20
--spotlight-z-index:  9000
--toast-z-index:     10000
--tooltip-z-index:   10001
```

Use these for all dropdowns, tooltips, and the command palette. The visual editor has additional raw z-index values for the layout chrome (sidebars, floating panels) and a separate internal ladder inside the canvas's isolating stacking context — those are intentional exceptions documented in [`docs/reference/design-tokens.md`](reference/design-tokens.md) → "Z-index layers".

### Spotlight

The Cmd+K command palette uses the same global panel, overlay, accent, state, and skeleton tokens as the rest of the admin chrome. Only its layout layer stays spotlight-scoped: `--spotlight-z-index` and `--spotlight-width`.

---

## Surface systems

The editor composes four kinds of surfaces. Each has its own token group, geometry, and rules.

### 1. Tile cards (`--bg-surface-2` on `--bg-surface`)

The dashboard pattern. Borderless tiles on a darker parent, 1px grid gap, 16px radius.

```css
.parent {
  background: var(--bg-surface);
  display: grid;
  gap: 1px;              /* the gap that becomes the visual divider */
}

.tile {
  background: var(--bg-surface-2);
  border: 0;
  border-radius: 16px;
  /* hover lifts the tone, never the border */
}
.tile:hover {
  background: var(--bg-surface-3);
}
```

Each tile usually carries:

- A **title row** with a small accent dot (7px, `--radius-sm`) + uppercase 11px label
- A **value** rendered large with `--text-bright`
- Optional micro-trend, chart, or list body

This is what reads as the Instatic dashboard aesthetic. Same pattern is used by the storage breakdown, posts widget, activity feed, etc. The "Add block" tile uses `box-shadow: inset 0 0 0 1px ...` to convey emptiness without breaking the borderless rule.

### 2. Floating Overlay Panels

Spotlight, popovers, modals, and command palettes. These sit above the editor with a blur backdrop:

```css
.panel {
  background: var(--bg-surface);              /* rgb(30 30 30) */
  border: 1px solid var(--overlay-10);    /* rgba(255,255,255,0.10) */
  border-radius: var(--panel-radius);       /* 12px */
  backdrop-filter: blur(var(--panel-blur)); /* 24px */
  box-shadow: var(--shadow-panel);          /* composite */
}
```

Floating panels are the only surface that uses a visible border + blur — they're explicitly stacked above the editor, so they advertise themselves with the border and the slight transparency that the blur reveals.

### 3. Inputs

Bordered, transparent, pill-shaped:

```css
.input {
  background: transparent;              /* transparent */
  border: 1px solid var(--overlay-20);    /* rgba(255,255,255,0.20) */
  border-radius: var(--input-radius);       /* 1em */
  color: var(--text);
}
.input:hover  { border-color: var(--overlay-30); }
.input:focus  { border-color: var(--overlay-50); box-shadow: var(--shadow-input-focus); }
```

The border is the input's identity. Don't fill them. Don't square the corners.

### 4. Panel rail (the colored sidebar)

42px-wide vertical rail of icon buttons. Each button carries a `data-accent` identity and a `--rail-icon-tint` custom property from the automatic rail-accent helper. The CSS derives the icon color, semi-transparent hover/active background, and glow from that token:

```css
.railButton {
  --rail-icon-tint: var(--accent-1);
  --rail-icon-color: var(--rail-icon-tint);
  --rail-icon-active-bg: color-mix(in oklab, var(--rail-icon-tint) 16%, transparent);
}
```

Icons in the rail get a `drop-shadow` glow matching their tint. The active rail item has a 2px tinted indicator on its left edge. Canonical CSS implementation: `src/admin/pages/site/sidebars/PanelRail/PanelRail.module.css`. Accent assignment logic: `src/ui/railAccent.ts` (`assignRailAccents` for multi-item groups, `railAccent` for single items).

This pattern (automatic per-item rail tint plus `data-accent` for inspection) is the recipe for any equivalent sidebar — media sidebar, data sidebar, content sidebar, etc.

### 5. Scrollbar chrome

Scrollable admin surfaces use a shared, quiet scrollbar: transparent track, muted achromatic thumb, and a slightly brighter hover state. Scrollbar styling lives in `src/styles/globals.css` so Firefox (`scrollbar-color`) and WebKit/Blink (`::-webkit-scrollbar`) stay visually aligned. Panel layouts that place a rail beside scrollable content should reserve a stable gutter so the scrollbar never covers rail icons.

---

## Components

Every interactive control in the admin and editor goes through a primitive from `src/ui/components/`. Bare `<button>` in `src/admin/*` is gated by `button-primitive-usage.test.ts` — the allowlist in that file documents the §8 exceptions.

| Primitive            | When to use                                                                 |
|----------------------|-----------------------------------------------------------------------------|
| `Button`             | Every action button. Variants for primary / secondary / ghost / danger.     |
| `Input`              | Single-line text input. Pill radius, transparent fill, bordered.            |
| `FormField`          | Label + description shell for form controls.                               |
| `Switch`             | Boolean toggle.                                                             |
| `Checkbox`           | Boolean within a list / form.                                               |
| `Select`             | Dropdown selection of fixed options.                                        |
| `SearchBar`          | Search input with magnifier icon and clear affordance.                      |
| `ColorInput`         | Color picker with swatch + hex.                                             |
| `FileUpload`         | Drop-zone + browse for file inputs.                                         |
| `DateTimePicker`     | Date / time inputs.                                                         |
| `RangeTabs`          | Tabbed numeric range selectors (e.g. spacing scales).                       |
| `SegmentedControl`   | A few mutually exclusive options shown inline.                              |
| `Tabs`               | Top-level tab navigation within a workspace.                                |
| `Stack`              | Small flex layouts for host/admin and plugin UI.                            |
| `Separator`          | Visual divider between sections.                                            |
| `Section`            | Titled section block in panels.                                             |
| `ControlRow`         | Standard label + control row in property panels.                            |
| `Card`               | Token-backed panel surface for grouped host/admin content.                  |
| `ContextMenu`        | Right-click and `…` overflow menus.                                         |
| `FilterBar`          | Compound filter row (type + folder + date + query).                         |
| `TagPill`            | Compact tinted labels, selector chips, removable tag pills. It derives a token-backed tint from the first meaningful alphanumeric character. |
| `FloatingActionBar`  | Multi-select bulk-action bar.                                               |
| `EmptyState`         | Empty-list / empty-page placeholder.                                        |
| `Alert`              | Inline non-blocking status/error message.                                   |
| `Dialog`             | Modal dialog with a title and content.                                      |
| `Tooltip`            | Hover and cursor-anchored tooltips. Replaces the native `title` attribute (gated). |
| `Toast`              | Transient confirmation / error notifications.                               |
| `DataTable`          | Token-backed table shell; callers own row state, sorting, and selection.    |
| `Widget`, `WidgetSkeleton`, `WidgetList` | Borderless tile card and dashboard/widget list helpers. Accepts a `tint`. |
| `Heading`, `Text`, `Code` | Typography primitives for host/admin and plugin UI.                   |
| `Image`              | Image with built-in blurhash fallback.                                      |
| `CanvasModulePlaceholder`| Diagonal-stripe placeholder for empty modules.                          |
| `ErrorBoundary`      | Component-level error containment.                                          |
| `SkeletonBlock`, `SkeletonCards`, `SkeletonRows`, `SkeletonTree` | Loading-state shimmer primitives. Four named shapes cover nearly every loading region. `SkeletonTree` renders depth-indented placeholder rows with cascading shimmer for tree panels (Layers, Selectors). Shimmer uses `--bg-surface-3/4` tokens. |
| `Kbd`, `ShortcutKeys` | Keyboard keycap and shortcut-sequence primitives. `Kbd` renders a single keycap; `ShortcutKeys` splits a full label ("⌘K", "Ctrl+Shift+P") into per-key `Kbd` spans. Single canonical style across all keyboard hint surfaces (Spotlight footer, module inserter legend, keybindings help screen). |

For tree-shaped controls (DOM panel, layers panel, site tree), use `Tree*` from `src/admin/pages/site/ui/Tree/`.

### Composition helper

Class composition uses `cn` from `@ui/cn` — a 3-line helper in `src/ui/cn.ts`. **Do not** add `clsx`, `tailwind-merge`, `class-variance-authority`, or `@radix-ui/*`. Gated by `no-tailwind-deps.test.ts`.

```ts
import { cn } from '@ui/cn'

<button className={cn(styles.btn, isActive && styles.active, props.className)} />
```

---

## Icons

Icons are TSX components from the vendored `pixel-art-icons` package. Each icon is its own file; deep-import so only used icons enter the module graph:

```tsx
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'

<ChevronRightIcon />
```

Rules:

- No barrel import (`import { X } from 'pixel-art-icons'`) — always `pixel-art-icons/icons/<name>`.
- No `lucide-react`, `heroicons`, `phosphor-icons`, or other catalogs. Gated by `no-third-party-icons.test.ts`.
- No inline SVG strings in components. Gated by `direct-icon-imports.test.ts`.
- Icons in the panel rail or equivalent identity surfaces are colored via `--rail-icon-color` (which is derived from `--rail-icon-tint`). Don't hardcode `color` on the icon itself.
- Adding a new icon: import it normally, then run `bun run icons:sync`. The vendored set is gated for freshness by `vendor-icons-fresh.test.ts`.

The full set (~4,053 icons) lives in the sibling repo `../pixel-art-icons`; the CMS vendors only the icons it actually imports.

Production builds fold those imported icon modules into one `pixel-art-icons-*`
chunk. That keeps source imports tree-shakeable while avoiding dozens of
sub-1 KB emitted icon chunks.

---

## CSS rules

### CSS Modules only

Files named `Component.module.css` next to `Component.tsx`. Class names are `camelCase`. No Tailwind utility classes in `src/admin/`, `src/modules/`, or `src/ui/` — gated by `noTailwindUtilities.test.ts`. Tailwind ecosystem dependencies are banned outright — gated by `no-tailwind-deps.test.ts`. This includes all palette names (`bg-zinc-100`, `text-blue-400`, etc.), arbitrary-value syntax (`min-h-[44px]`), and `@tailwind` / `@apply` directives.

```text
src/ui/components/Button/
├── Button.tsx
├── Button.module.css
└── index.ts
```

### No hardcoded colors in admin / ui CSS modules

Every color, gradient, and shadow in `src/admin/`, `src/admin/pages/site/`, and `src/ui/` CSS modules is a `var(--*)` reference. If the right token doesn't exist, add it to `globals.css` first. Gated by `css-token-policy.test.ts`.

❌ `color: #ededed;`
✅ `color: var(--text);`

**Exception:** `src/modules/*` is intentionally exempt — those CSS files ship to the published page output where admin tokens are not guaranteed to exist.

### No hardcoded spacing in admin / ui CSS modules

Admin spacing values in `margin*`, `padding*`, `gap`, `row-gap`, `column-gap`, and CSS-authored SVG dimensions use `var(--space-*)` tokens from `src/styles/globals.css`. Gated by `admin-spacing-token-policy.test.ts`.

❌ `padding: 12px 0;`
✅ `padding: var(--space-l) 0;`

**Exception:** `src/modules/*` is intentionally exempt — those CSS files ship to the published page output where admin tokens are not guaranteed to exist.

### No `var(--name, fallback)` in admin / ui CSS modules

Use bare `var(--name)` — never `var(--name, fallback)`. A fallback is either dead code (the token exists — drop the fallback) or a mask for a missing token (define the token in `globals.css` instead). Defaults for JS-driven custom properties belong in a CSS rule (`[data-x]` selector or `:root`), not scattered in every `var()` reader. Gated by `no-css-var-fallbacks.test.ts`.

❌ `color: var(--text-disabled, var(--text-subtle));`
✅ `color: var(--text-disabled);`

**Exception:** `src/modules/*` is exempt — those styles ship to published pages where fallbacks may be the only sensible default.

### No inline `style={{...}}` (with one exception)

Inline `style` is banned. The only legitimate use is **dynamic CSS custom properties** that the static module reads back via `var(--*)`:

```tsx
<div
  className={styles.module}
  style={{ '--module-min-height': `${minHeight}px` } as CSSProperties}
/>
```

```css
.module { min-height: var(--module-min-height); }
```

### No `!important`

Banned in component CSS modules. The only legitimate exceptions are:

- `globals.css` for the `prefers-reduced-motion` override
- `Button.module.css` for specificity reset on variant overrides

If you find yourself reaching for `!important`, the cascade is wrong — fix the selector.

---

## Accessibility

### Reduced motion

`@media (prefers-reduced-motion: reduce)` in `globals.css` zeroes animation / transition durations and disables smooth scroll. Every animated component must respect this — see `Widget.module.css`, `DashboardGrid.module.css`, and `PanelRail.module.css` for the pattern. Non-negotiable (Constraint #189).

### Focus

The achromatic focus ring is `--focus-ring` (1px white at 20% alpha). Inputs use a stronger composite focus glow via `--shadow-input-focus`. Never remove focus indicators without replacing them with a visible alternative.

### Color contrast

The text tokens (`--text-bright` → `--text-disabled`) pass WCAG AA against `--bg-body`. The semantic state tokens have a `*-text` variant (e.g. `--danger-text`, `--success-text`) chosen for use **on a tinted background** — use those instead of pairing a raw `--danger` with `--bg-body`.

### No native browser dialogs

`alert()`, `confirm()`, `prompt()` are banned — gated by `no-native-browser-dialogs.test.ts`. Use the `Dialog` primitive or component state with `role="alert"` / `role="status"`.

### No native title tooltips

The HTML `title` attribute is banned for hover hints — gated by `no-native-title-tooltips.test.ts`. Use the `Tooltip` primitive.

---

## Forbidden patterns

| Pattern                                                  | Use instead                                              |
|----------------------------------------------------------|----------------------------------------------------------|
| `<button>` in editor / admin code                        | `<Button>` from `src/ui/components/Button`               |
| `color: #ededed;` (hardcoded color)                      | `color: var(--text);`                             |
| `border: 1px solid #333;` (hardcoded border)             | `border: 1px solid var(--border);`                |
| `var(--text, #ededed)` (var with fallback)        | `var(--text)` — define the token in `globals.css` |
| `className="text-zinc-400"` (Tailwind utility)           | CSS Module class                                         |
| `className="bg-blue-500"`, `min-h-[44px]`, etc.          | CSS Module class with a token                            |
| `import { cn } from 'clsx'`                              | `import { cn } from '@ui/cn'`                            |
| `import { X } from 'lucide-react'`                       | `import { XIcon } from 'pixel-art-icons/icons/<name>'`   |
| `style={{ color: 'white' }}`                             | CSS Module class — `style` is only for CSS custom properties |
| `!important` in a component CSS module                   | Restructure selectors                                    |
| `alert('Saved!')`                                        | Toast or `role="status"` element                         |
| `<input title="Help text">` (hover hint)                 | `<Tooltip>` primitive                                    |
| Inline SVG icon string                                   | `pixel-art-icons/icons/<name>`                           |
| Card with a colored border                               | Borderless tile on a darker parent (1px gap pattern)     |
| Hover that changes a card's border color                 | Hover that lifts the surface tone (`-surface-2` → `-3`)  |
| Filling an input with a tinted background                | Transparent fill, white-alpha border                     |
| Inventing a one-off color for a category                 | Use `assignRailAccents` / `railAccent` from `@ui/railAccent`, or add a new tint token in `globals.css`|

---

## Adding a new design token

1. Add the CSS custom property to `src/styles/globals.css` in the appropriate group.
2. Add a one-line comment if the meaning isn't obvious from the name.
3. Use it via `var(--*)` in CSS modules.
4. If it represents a new concept (not a variation of an existing group), update [docs/reference/design-tokens.md](reference/design-tokens.md).

## Adding a new UI primitive

1. Create `src/ui/components/<Name>/<Name>.tsx`, `<Name>.module.css`, and `index.ts`.
2. Export from the primitive folder's `index.ts` so consumers import from `@ui/components/<Name>`.
3. The primitive must work with the existing tokens — do not introduce new colors, radii, font sizes, or spacing values to support it. If you need new tokens, see "Adding a new design token" first.
4. If it replaces a bare HTML control (`button`, `input`, etc.), update the matching architecture test's allowlist or gate.
5. Document it in the components table above and (if it has non-obvious usage) write a short [docs/reference/ui-primitives.md](reference/ui-primitives.md) entry.

## Adding a new tile-card surface

1. Use `--bg-surface` on the parent container with `display: grid` and `gap: 1px`.
2. The tile body is `background: var(--bg-surface-2)`, `border: 0`, `border-radius: var(--card-radius)`.
3. Hover lifts to `--bg-surface-3` — never recolor the border.
4. Add a title row with an accent dot (7px, `--radius-sm` (3px), `background: var(--tint)`).
5. Use `assignRailAccents` from `@ui/railAccent` for multi-item surfaces (avoids repeats in the visible group) or `railAccent` for a single item. Skip if the surface has a product-defined category.
6. Reuse `Widget` from `src/ui/components/Widget/` unless the surface fundamentally differs.

---

## Related

- [docs/CONVENTIONS.md](CONVENTIONS.md) — how docs in this repo are structured
- [docs/architecture.md](architecture.md) — system overview
- [docs/reference/design-tokens.md](reference/design-tokens.md) — complete token catalog
- [docs/reference/ui-primitives.md](reference/ui-primitives.md) — primitive usage cookbook
- Source-of-truth files:
  - `src/styles/globals.css` — all tokens
  - `src/ui/components/` — all primitives
  - `src/ui/cn.ts` — class composition helper
  - `src/ui/railAccent.ts` — rail accent assignment helpers (`railAccent`, `assignRailAccents`, `railTintVar`, `RAIL_ACCENTS`, `RailAccent`)
  - `src/ui/components/Widget/Widget.module.css` — canonical tile-card implementation
  - `src/admin/pages/dashboard/components/DashboardGrid.module.css` — canonical 1px-gap grid
  - `src/admin/pages/site/sidebars/PanelRail/PanelRail.module.css` — canonical tinted rail CSS
  - `vendor/pixel-art-icons/` — vendored icon set
- Gate tests:
  - `src/__tests__/architecture/css-token-policy.test.ts` — no hardcoded colors in admin / ui CSS modules
  - `src/__tests__/architecture/admin-spacing-token-policy.test.ts` — admin / ui margin, padding, gap, and CSS-authored SVG dimensions use fluid `--space-*` tokens
  - `src/__tests__/architecture/no-css-var-fallbacks.test.ts` — no `var(--name, fallback)` in admin / ui CSS modules
  - `src/__tests__/architecture/scrollbar-chrome.test.ts` — scrollbar tokens declared in `globals.css`; both Firefox and WebKit/Blink implementations use them; properties panel uses `scrollbar-gutter: stable`
  - `src/__tests__/architecture/noTailwindUtilities.test.ts` — no Tailwind utility classes (covers all palette names)
  - `src/__tests__/architecture/no-tailwind-deps.test.ts` — no Tailwind ecosystem dependencies
  - `src/__tests__/architecture/button-primitive-usage.test.ts` — every button goes through `Button`
  - `src/__tests__/architecture/ui-primitives-location.test.ts` — primitives live in `src/ui/components/`
  - `src/__tests__/architecture/no-third-party-icons.test.ts` — icons come from `pixel-art-icons`
  - `src/__tests__/architecture/direct-icon-imports.test.ts` — no inline SVG strings
  - `src/__tests__/architecture/vendor-icons-fresh.test.ts` — vendored icon set is fresh
  - `src/__tests__/architecture/no-native-browser-dialogs.test.ts` — no `alert` / `confirm` / `prompt`
  - `src/__tests__/architecture/no-native-title-tooltips.test.ts` — no `title=` hover hints
  - `src/__tests__/architecture/close-icon-correctness.test.ts` — close icons render the right glyph
