import type { ComponentType, ReactNode } from 'react'
import type { IconComponent } from 'pixel-art-icons/types'
import type { TSchema } from '@core/utils/typeboxHelpers'
import type { PropertySchema } from './propertySchema'

export type {
  PropertyCondition,
  PropertyControl,
  PropertyControlLayout,
  PropertySchema,
} from './propertySchema'

// ---------------------------------------------------------------------------
// Module package dependencies — dependency-backed editor runtimes
// ---------------------------------------------------------------------------

interface ModuleDependencySpec {
  /** Semver/range tracked for dependency-backed module runtimes. */
  version: string
  /** true writes to devDependencies; false/omitted writes to dependencies. */
  dev?: boolean
}

export type ModuleDependencies = Record<string, string | ModuleDependencySpec>

// ---------------------------------------------------------------------------
// Editor runtime sandbox — dependency-backed live previews
// ---------------------------------------------------------------------------

interface ModuleSandboxRuntime {
  /**
   * ESM source executed inside an isolated editor iframe. The module should
   * export `mount(root, context)`. `mount()` may return a cleanup function or
   * `{ update, cleanup }`. Exporting `update(root, context)` is also supported.
   * Implement `update` for seamless property edits without iframe/WebGL reloads.
   */
  source: string
  /** Minimum editor-frame height before class/module CSS overrides apply. */
  minHeight?: number
}

interface ModuleEditorRuntime {
  sandbox?: ModuleSandboxRuntime
}

// ---------------------------------------------------------------------------
// Render Output — the canonical return type for ModuleDefinition.render()
// Decision #309: render() returns { html, css? } not a plain string
// ---------------------------------------------------------------------------

export interface RenderOutput {
  /** Clean HTML string — no editor code, no React, no framework runtime */
  html: string
  /**
   * Optional scoped CSS for this module TYPE.
   * The publisher deduplicates across all instances (one CSS block per module type).
   */
  css?: string
  /**
   * Optional vanilla-JS runtime for this module TYPE, deduplicated per
   * moduleId exactly like `css` and served as an external per-module asset
   * (`/_instatic/module-js/<moduleId>.js`) on published pages — never inlined,
   * so no `</script>` escaping is needed. Authoring contract: a self-contained
   * IIFE; bind via document-level event delegation (hole fragments insert into
   * the DOM after load); idempotent; no load-order assumptions; no framework
   * runtimes. Never executed in the admin canvas (the canvas renders editor
   * React components, not published render() output).
   */
  js?: string
}

// ---------------------------------------------------------------------------
// Module Component Props — passed to the editor preview component
// ---------------------------------------------------------------------------

export interface ModuleComponentProps<
  TProps extends Record<string, unknown> = Record<string, unknown>,
> {
  props: TProps
  nodeId: string
  isSelected: boolean
  /** Already-rendered child module React nodes */
  children?: ReactNode
  /**
   * Space-separated CSS class string derived from node.classIds
   * (e.g. "hero_title cta_button"). Module editor components must apply this
   * directly to their root JSX element so CSS class rules target the
   * module element instead of the NodeWrapper wrapper div.
   * Task #401 Bug 1 fix.
   */
  mcClassName?: string
  /**
   * Bag of editor attributes and event handlers the module MUST spread onto
   * its root JSX element. The canvas wires selection, hover, double-click,
   * context-menu, keyboard activation, and DOM-tree traversal through these
   * — without them the node is invisible to the editor's interaction layer.
   *
   * This used to live on a wrapping `<div class="nodeWrapper">` element
   * inserted by the canvas. That wrapper broke CSS combinators like
   * `body > nav` and `:nth-child()` because the wrapper sat between every
   * authored element pair. Moving the editor attributes onto the module's
   * own root element eliminates the wrapper entirely, so the canvas DOM
   * matches the published DOM exactly.
   *
   * `undefined` outside the editor (publisher, plugin sandbox preview, etc.)
   * — modules should treat absence as "render plain published markup".
   */
  nodeWrapperProps?: NodeWrapperProps
}

/**
 * Editor attributes + event handlers a module spreads onto its root element
 * so the canvas can drive selection / hover / context-menu / keyboard
 * activation through the user's authored DOM directly (no wrapper div).
 */
export interface NodeWrapperProps {
  // Identity + selection fields. Present for EDITABLE nodes (built by the
  // canvas NodeRenderer). They are optional because the same spread channel
  // also carries the read-only markers below for NON-editable composed content
  // (template chrome, inlined components, outlet previews), which deliberately
  // has no node identity — it is not selectable, only labelled.
  'data-node-id'?: string
  'data-module-id'?: string
  tabIndex?: 0
  'data-canvas-selected'?: 'true'
  'data-hovered'?: 'true'
  /**
   * Read-only region markers, spread onto every element of a non-editable
   * composed subtree (`ReadOnlyNodeTree`). The canvas reads the nearest
   * ancestor carrying these to show a "part of X — double-click to edit" hint
   * and to open the source on double-click. `kind` routes the open action
   * ('page' → openPageInCanvas, 'component' → setActiveDocument).
   */
  'data-instatic-readonly-label'?: string
  'data-instatic-readonly-kind'?: 'page' | 'component'
  'data-instatic-readonly-id'?: string
  /**
   * The node's inline styles (`node.inlineStyles`) as a React style object, so
   * the canvas preview matches the published `style="…"` attribute. Present
   * only when the node has inline styles; sanitised to the same gate the
   * publisher applies. Modules spread this onto their root element.
   */
  style?: Record<string, string | number>
  onPointerDownCapture?: (e: SyntheticMouseEvent) => void
  onMouseDownCapture?: (e: SyntheticMouseEvent) => void
  onFocusCapture?: (e: SyntheticFocusEvent) => void
  onClickCapture?: (e: SyntheticMouseEvent) => void
  onClick?: (e: SyntheticMouseEvent) => void
  onDoubleClickCapture?: (e: SyntheticMouseEvent) => void
  onDoubleClick?: (e: SyntheticMouseEvent) => void
  onContextMenuCapture?: (e: SyntheticMouseEvent) => void
  onContextMenu?: (e: SyntheticMouseEvent) => void
  onKeyDown?: (e: SyntheticKeyboardEvent) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

// Loose synthetic-event types so plugin module authors aren't forced to
// import React types at the type level. The shapes match React's
// SyntheticEvent surface for the methods modules actually need.
type SyntheticMouseEvent = {
  target: EventTarget | null
  currentTarget: EventTarget | null
  preventDefault: () => void
  stopPropagation: () => void
}
type SyntheticKeyboardEvent = SyntheticMouseEvent & {
  key: string
}
type SyntheticFocusEvent = SyntheticMouseEvent

// ---------------------------------------------------------------------------
// Module Definition — the canonical contract every module must satisfy
// Source of truth: Contribution #309
// ---------------------------------------------------------------------------

export interface ModuleDefinition<
  TProps extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Globally unique, namespaced ID.
   * Format: "{namespace}.{module-name}" — e.g. "base.text", "acme.hero-banner"
   * Constraint #181: no bare IDs, namespace required.
   */
  id: string

  /** Human-readable display name */
  name: string

  /** Optional description shown in the Module Library */
  description?: string

  /** Category for grouping in the Module Library */
  category: string

  /**
   * Module icon — concrete icon component from `pixel-art-icons`.
   *
   * Single source of truth for the icon shown next to a module everywhere in
   * the editor: layer tree rows, the canvas notch quick actions, the
   * Properties Panel "Module settings" header, and the module picker popover.
   * Use the shared `ModuleIcon` resolver (see `src/editor/ui/ModuleIcon`)
   * instead of consuming `icon` directly when rendering against a moduleId.
   */
  icon: IconComponent

  /** Semver string e.g. "1.0.0" */
  version: string

  /**
   * Trust level — determines sandbox strategy.
   * true  = base/trusted module → component mounts directly in editor React tree
   * false = sandboxed plugin module → component runs inside <iframe sandbox="allow-scripts">
   *                                   with a future postMessage bridge host
   * Constraint #218: decided in Contribution #309
   */
  trusted: boolean

  /**
   * Whether this module can contain child nodes.
   * Replaces the former `slots?: SlotDefinition[]` for MVP simplicity.
   * All children go into a single default slot.
   */
  canHaveChildren: boolean

  /**
   * How the publisher's node walker dispatches this module. Makes the
   * otherwise-invisible two-tier render contract explicit on the definition:
   *
   * - `'standard'` (default): the normal bottom-up flow in `renderStandardNode`
   *   — render children → resolve/escape props → call `render()` → inject
   *   classes. Almost every module.
   * - `'special'`: the walker replaces the standard flow with a publisher-side
   *   specialised renderer keyed by module id (`base.loop`, `base.visual-component-ref`).
   *   A module declaring `'special'` MUST have a matching renderer registered in
   *   the publisher, and the publisher only takes the special path when the
   *   module declares it — so a special module must opt in here, it can no
   *   longer be special purely by living in a hardcoded id list.
   * - `'transparent'`: the node contributes nothing on its own — its `render()`
   *   MUST return empty HTML (validated at registration). Its content reaches
   *   the page through another mechanism (slot-instance children are emitted at
   *   the matching slot-outlet position). Used by `base.slot-instance` /
   *   `base.slot-outlet`.
   *
   * Omit for the standard path.
   */
  publishBehavior?: 'standard' | 'special' | 'transparent'

  /**
   * When `true`, this module's render output varies per visitor request and
   * cannot be pre-rendered into a static disk artefact at publish time.
   *
   * Layer A's dynamic-node detection checks this flag to classify pages as
   * dynamic. Layer C uses it to emit `<instatic-hole>` placeholders around the
   * node at publish time, with the actual render deferred to request time.
   *
   * No first-party module sets this to `true` yet — the flag is
   * infrastructure for plugin authors building modules that hit live APIs,
   * depend on per-visitor state, or otherwise cannot run at publish time.
   * See `docs/features/plugin-system.md`.
   */
  dynamic?: boolean

  /**
   * Optional loading state rendered at publish time into the `<instatic-hole>`
   * placeholder element. Called once at publish time (not per-request).
   *
   * When present, its output is sanitised via `sanitizeRichtext` before
   * being baked into the placeholder. Non-JS visitors see this content
   * as a meaningful fallback; JS visitors see it briefly until the hole
   * runtime swaps in the server-rendered fragment.
   *
   * If omitted, the `<instatic-hole>` element is empty (zero visible content
   * until the runtime fires). Only applies when `dynamic: true` OR when
   * the node is otherwise classified as dynamic by auto-detection.
   */
  staticPlaceholder?: (props: TProps) => string

  /**
   * Declarative property schema — maps prop key → PropertyControl.
   * This is the sole source of truth for the Properties Panel UI.
   * Modules must NOT render their own property controls.
   * Keys must be flat (no dot-paths). Constraint #212.
   */
  schema: PropertySchema

  /**
   * Optional TypeBox schema that declares the full shape and per-field
   * defaults for this module's props. When present, `validateNodeProps`
   * coerces and default-fills props at the publisher boundary (soft — never
   * throws). The schema is the single source of truth for shape + defaults;
   * `defaults` should be derived from it via `Value.Create(propsSchema)`.
   *
   * Publisher-injected render-time fields (`_resolvedMediaByKey`,
   * `_resolvedAutoSizes`) must NOT appear in this schema — they are
   * injected after the coercion step and survive through the merge.
   */
  propsSchema?: TSchema

  /** Default property values matching the schema */
  defaults: TProps

  /**
   * SiteDocument-level package dependencies required when this module is inserted.
   * These are written to the user's site manifest, not installed into the
   * builder app. Runtime dependencies use string shorthand:
   * `{ three: "^0.184.0" }`; dev dependencies use `{ version, dev: true }`.
   */
  dependencies?: ModuleDependencies

  /**
   * React component for the editor canvas live preview.
   * - trusted modules: mounted directly in the editor React tree
   * - untrusted modules: rendered via a future iframe bridge host
   * NEVER called by the publisher.
   */
  component: ComponentType<ModuleComponentProps<TProps>>

  /**
   * Optional dependency-backed editor runtime. When present, the canvas renders
   * this module in a sandboxed iframe with an import map built from the module's
   * site dependencies, so packages like `three` do not become builder deps.
   */
  editorRuntime?: ModuleEditorRuntime

  /**
   * PURE FUNCTION — called by the CMS publisher for each node during page rendering.
   * Constraint #179 (hard): Must have zero side effects.
   * - No React, no ReactDOM, no JSX
   * - No DOM access (no document/window/navigator)
   * - No imports from src/editor/
   * - ALL string props MUST be HTML-escaped before interpolation
   * - MUST reject javascript: URLs in href/src/action attributes
   * Decision #309: returns RenderOutput { html, css? } not a plain string
   */
  render: (props: TProps, renderedChildren: string[]) => RenderOutput

  /**
   * Display-only hint for which HTML tag this module emits as its root element
   * for the given props. Surfaced in the DOM/Layers panel as a `<tag>` badge
   * next to each row so authors can see the underlying semantics at a glance
   * (e.g. a Container with `tag: 'header'` displays `<header>`; a Button with
   * a non-empty `href` displays `<a>`).
   *
   * Return `null` for modules that don't emit a single deterministic root tag
   * (visual-component-ref, slot-outlet, loop, etc.). The badge is hidden in
   * that case.
   *
   * NOT consumed by the publisher — `render()` remains the source of truth for
   * emitted HTML. This is a pure metadata function for editor display.
   */
  htmlTag?: string | ((props: TProps) => string | null)
}

// ---------------------------------------------------------------------------
// Module Registry interface
// ---------------------------------------------------------------------------

/**
 * Type-erased module shape used by the heterogeneous registry. Every concrete
 * `ModuleDefinition<TProps>` widens to this; the publisher and registry deal
 * with props as `Record<string, unknown>` because at runtime that's all they
 * have. Module authors keep their own narrow `TProps` at the definition site.
 *
 * Conversions from `ModuleDefinition<T>` to `AnyModuleDefinition` happen once
 * at the registry boundary (see `ModuleRegistry.register`), never in user code.
 */
export type AnyModuleDefinition = ModuleDefinition<Record<string, unknown>>

export interface IModuleRegistry {
  // Heterogeneous collection — each module has its own TProps. Module-specific
  // typing lives at the call site; the registry only sees the erased shape.
  register<T extends Record<string, unknown>>(definition: ModuleDefinition<T>): void
  registerOrReplace<T extends Record<string, unknown>>(definition: ModuleDefinition<T>): void
  unregister(id: string): void
  get(id: string): AnyModuleDefinition | undefined
  getOrThrow(id: string): AnyModuleDefinition
  has(id: string): boolean
  list(): AnyModuleDefinition[]
  listByCategory(): Record<string, AnyModuleDefinition[]>
  /** Subscribe to registration changes — used by the editor canvas. */
  subscribe(listener: () => void): () => void
  /** Monotonic counter that bumps on every register / unregister. */
  generation(): number
}
