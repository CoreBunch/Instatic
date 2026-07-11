# Design Tokens

The complete catalog of design tokens declared in `src/styles/globals.css`. Every color, radius, shadow, font, font size, spacing value, and z-index used by the admin / editor / UI primitives is here. CSS Modules in `src/admin/`, `src/admin/pages/site/`, and `src/ui/` MUST reference these via `var(--*)` — hardcoded hex / rgb / hsl is gated by `css-token-policy.test.ts`, hardcoded font-size pixels are gated by `admin-typography-token-policy.test.ts`, and hardcoded margin / padding / gap pixels are gated by `admin-spacing-token-policy.test.ts`.

---

## TL;DR

- One file: `src/styles/globals.css`.
- Grouped by role: fonts/fluid type, fluid spacing, core surfaces/text/borders, overlays/scrims, identity accents, semantic state, radii, shadows, canvas, syntax, and z-index.
- **Two-layer color model**: achromatic base + semantic / categorical color layer on top. See [docs/design.md](../design.md) for the rationale.
- Add a new token by editing `globals.css`. Reference it with `var(--your-token)` in CSS Modules.
- The `src/modules/` directory is **exempt** from the no-hardcoded-color rule — module CSS ships to published pages where admin tokens are not guaranteed to exist.

---

## Fonts

```css
--font-sans: "Inter Variable", system-ui, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```

Token names: `--font-sans`, `--font-mono`.

Inter Variable is loaded via a targeted `@font-face` declaration in `globals.css` — Latin subset only (`unicode-range: U+0000-00FF, …`), with `font-display: swap`. Non-Latin characters fall back to `system-ui`. The monospace stack is entirely system-native; no custom monospace font is loaded.

If the admin UI needs broader character coverage, add a second `@font-face` block in `globals.css` with the appropriate `unicode-range` pointing at the matching subset file under `@fontsource-variable/inter/files/`.

## Fluid type scale

Admin UI font sizes use the Core Framework-style `--text-*` scale directly. These tokens are fluid across viewport width but intentionally narrow for dense admin chrome. Use the nearest semantic step instead of introducing one-off pixel sizes.

Settings → Preferences can remap the scale through `data-editor-text-scale` on the document and layout roots. The `small`, `large`, and `extra-large` options shift the same token names down or up the base scale, so component CSS continues to say `font-size: var(--text-s)` rather than branching per preference.

Each visible token has a stable base token used by those preference remaps: `--text-3xs-base`, `--text-2xs-base`, `--text-xs-base`, `--text-s-base`, `--text-m-base`, `--text-l-base`, `--text-xl-base`, `--text-2xl-base`, `--text-3xl-base`, `--text-4xl-base`, `--text-5xl-base`, `--text-6xl-base`, `--text-7xl-base`.

| Token        | Fluid range | Typical use                                      |
|--------------|-------------|--------------------------------------------------|
| `--text-3xs` | 8px → 9px   | Tiny badges, axis labels, micro metadata         |
| `--text-2xs` | 9px → 10px  | Dense metadata, compact chips                    |
| `--text-xs`  | 10px → 11px | Panel labels, toolbar chrome, descriptions       |
| `--text-s`   | 11px → 12px | Default compact body text, inputs, buttons       |
| `--text-m`   | 12px → 13px | Card/body copy and readable secondary text       |
| `--text-l`   | 13px → 14px | Section titles and prominent labels              |
| `--text-xl`  | 14px → 16px | Dialog titles and compact page titles            |
| `--text-2xl` | 16px → 18px | Page headings                                    |
| `--text-3xl` | 18px → 20px | Large page headings                              |
| `--text-4xl` | 20px → 24px | Hero numbers / large empty states                |
| `--text-5xl` | 24px → 28px | Display headings                                 |
| `--text-6xl` | 32px → 40px | KPI values                                       |
| `--text-7xl` | 40px → 56px | Largest admin display values                     |

These are admin tokens. The published-site Framework engine also emits short names such as `--text-s`; those belong to the generated site CSS, not admin chrome. Editor chrome injected into the canvas iframe maps admin sizes to `--chrome-text-*` before using them so it cannot override the site's Framework typography.

---

## Fluid spacing scale

Admin UI spacing uses the Core Framework-style `--space-*` scale directly. Use these tokens for CSS-authored `margin`, `padding`, `gap`, `row-gap`, `column-gap`, and SVG width/height values in admin and shared UI CSS modules. Keep true hairlines on `--space-px`.

| Token          | Fluid range | Typical use                                  |
|----------------|-------------|----------------------------------------------|
| `--space-px`   | 1px fixed   | Hairline gaps and exact 1px spacing          |
| `--space-4xs`  | 2px → 3px   | Micro offsets, dense icon nudges             |
| `--space-3xs`  | 3px → 4px   | Very tight inline padding                    |
| `--space-2xs`  | 4px → 5px   | Tight chip gaps                              |
| `--space-xs`   | 5px → 6px   | Compact control gaps                         |
| `--space-s`    | 6px → 8px   | Default dense row gaps                       |
| `--space-m`    | 8px → 10px  | Default panel/control spacing                |
| `--space-l`    | 10px → 12px | Section row padding                          |
| `--space-xl`   | 12px → 14px | Dialog/control interior padding              |
| `--space-2xl`  | 14px → 16px | Larger panel gaps                            |
| `--space-3xl`  | 16px → 18px | Icon-size SVGs and roomy control gaps        |
| `--space-4xl`  | 18px → 20px | Compact empty-state spacing                  |
| `--space-5xl`  | 20px → 24px | Card and modal spacing                       |
| `--space-6xl`  | 24px → 28px | Large controls / icon tiles                  |
| `--space-7xl`  | 28px → 32px | Page-section rhythm                          |
| `--space-8xl`  | 32px → 40px | Large page body spacing                      |
| `--space-9xl`  | 40px → 48px | Prominent empty-state spacing                |
| `--space-10xl` | 48px → 56px | Large dashboard/display spacing              |
| `--space-11xl` | 56px → 72px | Large SVG previews and major vertical gaps   |
| `--space-12xl` | 84px → 108px| Largest admin display spacing                |

These are admin tokens. The published-site Framework engine also emits short names such as `--space-s`; those belong to the generated site CSS, not admin chrome. Editor chrome injected into the canvas iframe maps admin spacing to `--chrome-space-*` before using it so it cannot override the site's Framework spacing.

---

## Surface hierarchy (achromatic base)

Six surface tones for depth. Lighter is higher in the stack.

The default values below are the dark theme. `data-editor-theme="light"` on the document or layout root overrides the same token names in `globals.css`, so component CSS stays theme-agnostic.

| Token                  | Hex       | Use                                                            |
|------------------------|-----------|----------------------------------------------------------------|
| `--bg-body`          | `#000000` | Page bottom — root, behind everything                          |
| `--bg-surface`     | `#1b1b1b` | Darker parent of tile cards / sidebar fill                     |
| `--bg-surface-2`   | `#282828` | Tile cards themselves, panel bodies                            |
| `--bg-surface-3`   | `#323232` | Tile/card hover, nested structural surfaces                    |
| `--bg-surface-4`   | `#4a4a4a` | Stronger nested structural surface                             |
| `--bg-surface-5`   | `#605f5f` | Strongest nested structural surface                            |

Tile/card hovers change **tone**, not border. Compact interactive chrome — buttons, segmented controls, toolbar chips, selected rows, and pressed states — uses `--overlay-5/10/20/30` for state fills so light and dark themes keep the same visible hierarchy.

---

## Borders

| Token                  | Hex       | Use                                                            |
|------------------------|-----------|----------------------------------------------------------------|
| `--border`      | `#333333` | Default 1px borders on input controls, dividers                |
| `--border-muted`  | `#2e2e2e` | Slightly elevated borders (active states on bordered controls) |
| `--border-subtle`| `#1f1f1f` | Quiet dividers and low-emphasis panel edges                    |
| `--border-strong`| `#4a4a4a` | Stronger structural borders and high-emphasis separators       |

---

## Text hierarchy

Five tones, each a different meaning level.

| Token                       | Hex       | Means                          |
|-----------------------------|-----------|--------------------------------|
| `--text-bright`      | `#f4f4f5` | Titles, headings, KPIs         |
| `--text`             | `#ededed` | Primary body text              |
| `--text-muted`   | `#a1a1aa` | Labels, secondary UI           |
| `--text-subtle`       | `#787878` | Muted / placeholder            |
| `--text-disabled`      | `#52525b` | Disabled / very subtle         |

Add a new text tone only by adding a new token here.

---

## Scrollbar chrome

Scrollbars are admin chrome, not identity. Keep them achromatic so the panel rail remains the dominant colored vertical affordance.

| Token                            | Value / source                                                      | Use                                           |
|----------------------------------|---------------------------------------------------------------------|-----------------------------------------------|
| `--scrollbar-size`        | `6px`                                                               | WebKit/Blink scrollbar width and height       |
| `--scrollbar-radius`      | `var(--radius-sm)`                                           | Thumb radius                                  |
| `--scrollbar-track`       | `transparent`                                                       | Track and corner background                   |
| `--scrollbar-thumb`       | `color-mix(in srgb, var(--text-subtle) 58%, transparent)`     | Default thumb color, also Firefox thumb color |
| `--scrollbar-thumb-hover` | `color-mix(in srgb, var(--text-muted) 72%, transparent)` | Hover thumb color                             |

`globals.css` applies these through `scrollbar-color` for Firefox and `::-webkit-scrollbar` for WebKit/Blink. Scrollable panel layouts that place rail navigation beside content should use `scrollbar-gutter: stable`.

---

## Overlays and scrims

Foreground overlays are used for selected rows, pressed states, borders, compact control tracks, and subtle surface lifts. The dark theme uses white overlays; the light theme swaps the same token names to dark overlays. Black scrims are used for shadows and modal backdrops. Suffixes are alpha x 100.

Overlay tokens: `--overlay`, `--overlay-5`, `--overlay-10`, `--overlay-20`, `--overlay-30`, `--overlay-40`, `--overlay-50`, `--overlay-60`, `--overlay-70`, `--overlay-80`, `--overlay-90`.

Scrim tokens: `--scrim`, `--scrim-10`, `--scrim-20`, `--scrim-30`, `--scrim-40`, `--scrim-50`, `--scrim-60`, `--scrim-70`, `--scrim-80`, `--scrim-90`.

---

## Identity accents

Token-backed identity colors for widget categories, panel rails, sidebar icons, tag pills, and storage breakdown segments. Panel rails assign these automatically from the full panel identity with repeat avoidance inside the visible rail group.

| Token              | Hex       | Conventional category                                                  |
|--------------------|-----------|------------------------------------------------------------------------|
| `--accent-1` | `#8ee6c8` | "Saved / system / status"                                                  |
| `--accent-2`| `#c8b6ff` | "Pages / structure"                                                        |
| `--accent-3`  | `#9bdcff` | "Storage / data / configuration"                                           |
| `--accent-4`| `#ffc7a8` | "Posts / media / activity"                                                 |
| `--accent-5` | `#ffb6cd` | Secondary warm identity tint                                               |
| `--accent-6` | `#b8f28b` | Secondary green identity tint                                              |
| `--accent-7` | `#f7df72` | Secondary yellow identity tint                                             |
| `--accent-8` | `#83e7ff` | Secondary blue identity tint                                               |
| `--accent-9` | `#f0a6ff` | Secondary violet identity tint                                           |
| `--accent-10` | `#ff9f9f` | Secondary red identity tint                                               |

Each accent also has a standard 10% tint for soft backgrounds: `--accent-1-10`, `--accent-2-10`, `--accent-3-10`, `--accent-4-10`, `--accent-5-10`, `--accent-6-10`, `--accent-7-10`, `--accent-8-10`, `--accent-9-10`, `--accent-10-10`. Used by `Widget` (`tint` prop), the rail accent helper (`src/ui/railAccent.ts`), `TagPill`, and the storage breakdown chart. The light theme overrides the same accent token names with darker foreground-safe variants, so shared rail icons and badge text stay readable on white surfaces. Adding another identity color requires a new token — don't inline a color.

---

## Tag pill accents

`TagPill` maps the first meaningful alphanumeric character of its label to a
stable numbered accent. This keeps selector punctuation from driving the color
while giving class names, HTML tags, and badges enough visual variety without
creating a second tag-specific tint scale.

---

## Semantic state (meaning layer)

### Danger / error

| Token                       | Value                              | Use                                   |
|-----------------------------|------------------------------------|---------------------------------------|
| `--danger`           | `#ef4444`                          | Error fill (button, badge, border)    |
| `--danger-light`     | `#f87171`                          | Lighter danger for text               |
| `--danger-lighter`   | `#fca5a5`                          | Very light danger tint                |
| `--danger-text`      | `#fecaca`                          | Danger badge text                     |
| `--danger-5`         | `rgba(239, 68, 68, 0.05)`          | Very quiet danger wash                |
| `--danger-10`        | `rgba(239, 68, 68, 0.1)`           | Danger pill / message surface         |
| `--danger-20`    | `rgba(239, 68, 68, 0.2)`           | Danger surface border                 |
| `--danger-30`        | `rgba(239, 68, 68, 0.3)`           | Stronger danger border / fill         |
| `--danger-40`        | `rgba(239, 68, 68, 0.4)`           | Highest danger alpha fill             |

### Warning

| Token                       | Value                              | Use                                   |
|-----------------------------|------------------------------------|---------------------------------------|
| `--warning`          | `#f59e0b`                          | Warning fill                          |
| `--warning-text`     | `#fde68a`                          | Warning badge text                    |
| `--warning-10`       | `rgba(245, 158, 11, 0.1)`          | Warning surface                       |
| `--warning-20`       | `rgba(245, 158, 11, 0.2)`          | Warning border / stronger wash        |
| `--warning-30`   | `rgba(245, 158, 11, 0.3)`          | Warning surface border                |

### Success

| Token                          | Value                              | Use                                   |
|--------------------------------|------------------------------------|---------------------------------------|
| `--success`       | `#34d399`                          | Saved / OK indicator                  |
| `--success-bright`      | `#4ade80`                          | Agent tool success                    |
| `--success-text`        | `#d1fae5`                          | Success badge text                    |
| `--success-text-muted`   | `#a7f3d0`                          | Success hint text                     |
| `--success-10`          | `rgba(52, 211, 153, 0.1)`          | Success pill surface                  |
| `--success-20`          | `rgba(52, 211, 153, 0.2)`          | Success wash / match highlight        |
| `--success-30`      | `rgba(52, 211, 153, 0.3)`          | Success pill / alert border           |
| `--success-40`          | `rgba(52, 211, 153, 0.4)`          | Highest success alpha fill            |

### Info

| Token                  | Value         | Use                                            |
|------------------------|---------------|------------------------------------------------|
| `--info-text`   | `#c4b5fd`     | Violet-tinted info text                        |

## Canvas (selection / hover affordances)

| Token                           | Use                                                           |
|---------------------------------|---------------------------------------------------------------|
| `--canvas-chrome-shadow`        | Achromatic drop shadow for canvas chrome overlays             |
| `--canvas-selection-ring`       | Neon green inset ring for the selected node                   |
| `--canvas-hover-ring`           | Neon pink inset ring for the hovered node                     |
| `--canvas-selector-ring`        | Neon orange inset ring for selector-panel match sweeps        |
| `--canvas-selection-ring-color` | Bare selection colour for outline / border / custom shadows   |
| `--canvas-hover-ring-color`     | Bare hover colour for outline / border / custom shadows       |
| `--canvas-selector-ring-color`  | Bare selector-affinity colour for custom shadows              |
| `--tree-drop-line`              | Drag-and-drop insertion line in tree views                    |
| `--tree-drop-line-shadow`       | Glow behind the tree insertion line                           |
| `--tree-drop-inside-bg`         | Valid drop-inside row background                              |
| `--tree-drop-inside-border`     | Valid drop-inside row border                                  |
| `--tree-drop-invalid-bg`        | Invalid drop row background                                   |
| `--tree-drop-invalid-border`    | Invalid drop row border                                       |
| `--canvas-placeholder-bg`       | Shared diagonal-stripe empty-module placeholder background    |
| `--canvas-live-scrim`           | Live-preview overlay scrim, theme-adjusted                    |

Bare colour variants (`*-ring-color`) are for surfaces that need an `outline` / `border-color` / custom shadow geometry rather than the full inset-ring shorthand. Keep them in sync with the shorthands. The selector ring (`#ff8800`) is a third distinct identity so a "show me everything this selector touches" sweep reads differently from selection (green) and hover (pink).

### Canvas placeholder

```css
--canvas-placeholder-bg:
    repeating-linear-gradient(
        -45deg,
        color-mix(in srgb, var(--text-subtle) 6%, transparent) 0 6px,
        transparent 6px 12px
    ),
    color-mix(in srgb, var(--text-subtle) 4%, transparent);
```

The shared diagonal-stripe pattern used by every module's "empty" placeholder (image, video, container, slot-outlet, VC ref placeholders). Strictly achromatic. Edit once, retune everywhere.

---

## Code editor syntax (GitHub Dark inspired)

Used inside CodeMirror only. Don't reach for these in editor chrome.

| Token                       | Hex         | Use                          |
|-----------------------------|-------------|------------------------------|
| `--syntax-keyword`   | `#ff7b72`   | Keywords (`if`, `return`)    |
| `--syntax-entity`    | `#d2a8ff`   | Function names, types        |
| `--syntax-property`  | `#7ee787`   | Object properties            |
| `--syntax-variable`  | `#ffa657`   | Variables                    |
| `--syntax-string`    | `#a5d6ff`   | String literals              |
| `--syntax-constant`  | `#79c0ff`   | Numbers, constants           |
| `--syntax-comment`   | `#8b949e`   | Comments                     |
| `--syntax-operator`  | `#c9d1d9`   | Operators, punctuation       |
| `--syntax-invalid`   | `#ffa198`   | Invalid syntax               |

---

## Border radius

| Token                | Value | Use                                                          |
|----------------------|-------|--------------------------------------------------------------|
| `--radius-sm` | 3px   | Tight chips, micro-badges, segmented-control inner indicator |
| `--radius`    | 6px   | Default editor controls, toolbar buttons, ghost menu items   |
| `--panel-radius`     | 12px  | Floating overlay panels                                      |
| `--card-radius`      | 16px  | Borderless tile cards (Widget, dashboard cells, module inserter tiles) |
| `--input-radius`     | 1em   | Pill-shaped inputs, class / property chips                   |
| `--tooltip-radius`   | 6px   | Tooltips                                                     |

---

## Shadows

| Token                          | Use                                                                       |
|--------------------------------|---------------------------------------------------------------------------|
| `--focus-ring`          | `0 0 0 1px var(--overlay-20)` — 1px achromatic focus ring         |
| `--panel-blur`                 | Backdrop blur amount for floating overlay panels                          |
| `--shadow-panel`               | Composite for floating panels: bottom-inset shadow + drop shadow           |
| `--shadow-panel-inset-bottom`  | Sub-token: `inset 0 -1px 0 var(--scrim-40)`                            |
| `--shadow-panel-drop`          | Sub-token: `0 12px 40px rgba(0, 0, 0, 0.65)`                               |
| `--shadow-input-focus`         | Inset composite achromatic glow for focused inputs                         |
| `--shadow-tooltip`             | `0 4px 16px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.04)`   |

Use `--shadow-panel` directly when you need a floating-panel feel. Don't recompose from the sub-tokens.

---

## Floating overlay panels

```css
background: var(--bg-surface);
border: 1px solid var(--overlay-10);
border-radius: var(--panel-radius);
backdrop-filter: blur(var(--panel-blur));
box-shadow: var(--shadow-panel);
```

Used by spotlight, popovers, modals — anything that floats above the editor with a blur backdrop.

---

## Inline code surface

```css
background: var(--scrim-30);
```

Used by the `Code` primitive for inline code chip backgrounds. Don't reuse for block-level code editors (that's CodeMirror, which uses the `--syntax-*` tokens).

---

## Keycap (Kbd primitive)

A sculpted, top-lit dark mechanical keycap. The face is a vertical gradient; the box-shadow stack fakes a raised cap — top highlight, concave inner shadow, a solid bottom edge, and a soft drop shadow. All values are achromatic, sitting inside the editor surface ramp.

| Token                  | Value                              | Use                                                  |
|------------------------|------------------------------------|------------------------------------------------------|
| `--kbd-face-top`       | `#434343`                          | Top of the face gradient (between surface-3 and -4) |
| `--kbd-face-bottom`    | `#2f2f2f`                          | Bottom of the face gradient (just below surface-3)  |
| `--kbd-face-top-hover` | `#4d4d4d`                          | Hover face gradient top (one step brighter)         |
| `--kbd-face-bottom-hover`| `#363636`                        | Hover face gradient bottom                          |
| `--kbd-border`         | `var(--border)`             | Keycap border — achromatic, same as editor controls |
| `--kbd-text`           | `var(--text-muted)`     | Key label text — same register as surrounding labels|
| `--kbd-highlight`      | `rgba(255, 255, 255, 0.06)`        | Top inner highlight (inset box-shadow)              |
| `--kbd-inner-shadow`   | `rgba(0, 0, 0, 0.22)`              | Soft concave bottom inner shadow                    |
| `--kbd-edge`           | `rgba(0, 0, 0, 0.30)`              | 1px bottom edge — the key's simulated thickness     |
| `--kbd-drop`           | `rgba(0, 0, 0, 0.28)`              | Small drop shadow beneath the cap                  |

These tokens are scoped to `Kbd` and `ShortcutKeys`. Don't reach for them in other components.

---

## Inputs

```css
background: transparent;
border: 1px solid var(--overlay-20);
border-radius: var(--input-radius);
color: var(--text);
```

```css
.field:hover { border-color: var(--overlay-30); }
.field:focus { border-color: var(--overlay-50); box-shadow: var(--shadow-input-focus); }
```

Cards are filled and borderless; inputs are unfilled and bordered. That's the load-bearing visual distinction between containers and controls.

---

## Z-index layers

Four global tokens cover the layered surfaces that float above the editor:

```css
--z-dropdown:           20;
--spotlight-z-index:  9000;
--toast-z-index:     10000;
--tooltip-z-index:   10001;
```

Token names: `--z-dropdown`, `--spotlight-z-index`, `--toast-z-index`, `--tooltip-z-index`.

`--tooltip-z-index` is deliberately the highest token so tooltips are never occluded by the surface their trigger lives on. `--toast-z-index` sits above modal layers and below tooltips. `--spotlight-z-index` is reused by several modal-level surfaces that need to sit above the editor chrome.

**Global modal layer** (all raw values in the shared admin stacking context):

| Value | What occupies it |
|-------|-----------------|
| 9000  | Spotlight backdrop (`--spotlight-z-index`); Settings modal backdrop; ModuleInserterDialog backdrop |
| 9001  | Settings dialog wrapper (`--spotlight-z-index + 1`) |
| 9050  | MediaPickerModal backdrop (`calc(--spotlight-z-index + 50)`) — sits above Settings because the picker can be opened from inside Settings (e.g. Settings → General → Favicon → Browse library…) |
| 10000 | BodySlashMenu — predates tokenisation; see inline comment in `BodySlashMenu.module.css` |
| 10001 | Tooltips (`--tooltip-z-index`); `AdminContextMenuGuard` |

The gap between 9001 (Settings dialog) and 9050 (MediaPickerModal) is intentional headroom for any future sub-dialogs inside Settings. The gap between 9050 and 10000 (BodySlashMenu) keeps the slash menu above all modal layers. Do not add new raw values into these ranges without updating this table.

The visual editor uses additional raw z-index values that are **not** tokenised. They fall into two independent stacking contexts:

**Editor layout context** (shared stacking context for the editor chrome):

| Value | What occupies it |
|-------|-----------------|
| 0     | `CanvasRoot` — an isolation root; all canvas-internal values are confined here |
| 30    | Main toolbar |
| 50    | Floating panels: PropertiesPanel, AgentPanel, DomPanel |
| 55    | LeftSidebar, RightSidebar, PanelRail |
| 90    | Shared admin floating windows (`FloatingWindow`, `MediaViewerWindow`, agent image preview) |
| 80    | CodeEditorPanel |
| 201   | Toolbar popovers / dropdowns |
| 400–401 | PreviewOverlay |

**Canvas-internal context** (confined inside CanvasRoot's `z-index: 0`):

| Value       | What occupies it |
|-------------|-----------------|
| 50          | PluginCanvasOverlayLayer |
| 51          | Selection ring, hover ring, selection toolbar |
| 53          | CanvasModeToggle, CanvasNotch |
| 60          | CanvasContextSelector |
| 2147483647  | Drop-indicator layer inside iframe (must beat arbitrary module stacking contexts) |

`CanvasRoot` declares `z-index: 0; position: relative` to establish the isolation. Without it, the canvas-internal z-index 51 would escape into the layout context and paint over floating panels at z-index 50. See [`docs/editor.md`](../editor.md) → "Canvas stacking context isolation" for the full explanation.

Raw canvas-internal values are intentional exceptions — they cannot be tokens because they are relative to an isolated stacking context, not the global one. Do not add new raw z-index values outside this established ladder.

---

## Tooltips

Tooltip chrome uses `--bg-body`, `--text-bright`, `--overlay-5`, `--shadow-tooltip`, `--tooltip-radius`, and `--tooltip-z-index` directly.

---

## Spotlight (Cmd+K command palette)

Spotlight has only layout/z-index tokens of its own. Its colors come from the same global overlay, scrim, text, and semantic state tokens as the rest of the admin UI.

| Token                              | Value                                  |
|------------------------------------|----------------------------------------|
| `--scrim-50`                       | Backdrop fill                          |
| `--backdrop-blur`        | `8px`                                  |
| `--spotlight-z-index`              | `9000`                                 |
| `--spotlight-width`                | `640px`                                |
| `--overlay-10`                    | Selected row and skeleton shimmer      |
| `--success-20`                    | Match highlight background             |
| `--danger-light` / `--danger-10`  | Destructive command states             |
| `--progress-shimmer`              | Travelling highlight on progress bars  |

---

## Bespoke surface tints

These tokens are narrow, named exceptions for authored surfaces that need a specific translucent treatment and cannot be expressed as a reusable semantic state.

| Token                    | Use                                      |
|--------------------------|------------------------------------------|
| `--plugins-hero-tint-a`  | First plugins workspace hero background tint |
| `--plugins-hero-tint-b`  | Second plugins workspace hero background tint |
| `--canvas-live-scrim`    | Theme-adjusted live-preview overlay scrim |

---

## Charts

Default chart tint, series colors, glow halos, empty-segment styling. Used by dashboard widgets and the framework scale UI.

| Token                          | Value                              | Use                                              |
|--------------------------------|------------------------------------|--------------------------------------------------|
| `--chart-default-tint`  | `var(--accent-4)`           | Fallback when no per-call tint                   |
| `--chart-series-min`           | `#38bdf8` (sky 400)                | "Mobile" series                                  |
| `--chart-series-min-glow`      | `rgba(56, 189, 248, 0.40)`         | Halo for active mobile segment                   |
| `--chart-series-max`           | `#4ade80` (green 400)              | "Desktop" series                                 |
| `--chart-series-max-glow`      | `rgba(74, 222, 128, 0.40)`         | Halo for active desktop segment                  |
| `--chart-segment-empty`        | `var(--overlay-5)`                 | Empty segment fill                               |
| `--chart-segment-empty-border` | `var(--overlay-5)`                 | Empty segment border                             |
| `--chart-track-bg`             | `var(--overlay-5)`                 | Track background behind chart segments           |

---

## Reduced motion

`globals.css` includes a non-negotiable reduced-motion override:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

The two `!important` declarations here are the **only legitimate `!important` usages** in `globals.css`. Constraint #189.

---

## Adding a new token

1. Pick the right group in `src/styles/globals.css` (color → semantic group; radius → radius group; z-index → z-index group).
2. Add the custom property with a one-line comment if the meaning isn't obvious from the name.
3. Reference it via `var(--*)` in CSS Modules.
4. Add a row to the matching table in this doc.
5. If it introduces a new concept (not a variation of an existing group), add a paragraph explaining what it's for in this doc and in [docs/design.md](../design.md).

---

## Forbidden patterns

| Pattern                                              | Use instead                              |
|------------------------------------------------------|------------------------------------------|
| `color: #ededed;` in an admin / ui CSS module        | `color: var(--text);`             |
| `border: 1px solid #333;`                            | `border: 1px solid var(--border);`|
| `box-shadow: 0 4px 16px rgba(0,0,0,0.5);`            | `box-shadow: var(--shadow-panel-drop);`  |
| Inventing a one-off radius                           | Use the radius scale                     |
| Inventing a one-off z-index                          | Use the existing z-index tokens          |
| Reaching for a one-off rail color                    | Use `railAccent` / `assignRailAccents`, or add a token |
| Hardcoding the canvas selection ring color           | `var(--canvas-selection-ring)`           |

---

## Related

- [docs/design.md](../design.md) — design principles + surface systems + UI primitives
- [docs/reference/ui-primitives.md](ui-primitives.md) — which primitive uses which tokens
- Source-of-truth file: `src/styles/globals.css`
- Gate tests:
  - `src/__tests__/architecture/css-token-policy.test.ts`
  - `src/__tests__/architecture/css-token-vocabulary.test.ts`
  - `src/__tests__/architecture/admin-typography-token-policy.test.ts`
  - `src/__tests__/architecture/admin-spacing-token-policy.test.ts`
  - `src/__tests__/architecture/noTailwindUtilities.test.ts`
  - `src/__tests__/architecture/no-css-var-fallbacks.test.ts`
  - `src/__tests__/architecture/scrollbar-chrome.test.ts` — scrollbar tokens declared; both Firefox and WebKit/Blink styled; properties panel uses `scrollbar-gutter: stable`
