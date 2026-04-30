// ---------------------------------------------------------------------------
// Page Tree — the document model (flat map structure)
//
// Decision #309 / Constraint #215–216:
// - Page.nodes is a Record<string, PageNode> (flat map)
// - PageNode.children is string[] (ordered child node IDs, single default slot)
// - Props are FLAT — no dot-path keys
//
// Benefits over nested tree:
// - O(1) node lookup: page.nodes[id]
// - Immer creates exactly ONE new reference per mutation (no ancestor cascade)
// - Test fixtures are trivially constructed
// - Clean Zustand selectors
// ---------------------------------------------------------------------------

import type { ProjectFile } from '../files/types'
export type { ProjectFile } from '../files/types'

import type { VisualComponent } from '../visualComponents/types'
export type { VisualComponent } from '../visualComponents/types'

import type { ProjectPackageJson } from '../project-dependencies/manifest'
export type { ProjectPackageJson } from '../project-dependencies/manifest'

import type { ProjectDataModel } from '../data-model/types'
export type { ProjectDataModel } from '../data-model/types'

// ---------------------------------------------------------------------------
// Phase C — CSS Class System types
// ---------------------------------------------------------------------------

/**
 * A typed, serialisable CSS property bag for the class system.
 * Only CSS properties that are both safe and common in web design are included.
 * Values are stored as strings (e.g. "16px", "1.5", "bold") so they map 1-to-1
 * to CSS declaration values and are trivially serialisable.
 */
export interface CSSPropertyBag {
  // Typography
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  fontStyle?: 'normal' | 'italic'
  letterSpacing?: string
  lineHeight?: string
  textAlign?: 'left' | 'center' | 'right' | 'justify'
  textDecoration?: string
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  color?: string
  textShadow?: string

  // Layout
  display?: 'block' | 'flex' | 'grid' | 'inline' | 'inline-block' | 'inline-flex' | 'none'
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
  flexWrap?: 'nowrap' | 'wrap'
  alignItems?: string
  justifyContent?: string
  justifyItems?: string
  alignSelf?: string
  justifySelf?: string
  flex?: string
  gap?: string
  rowGap?: string
  columnGap?: string
  gridTemplateColumns?: string
  gridTemplateRows?: string
  gridColumn?: string
  gridRow?: string

  // Size
  width?: string
  height?: string
  minWidth?: string
  maxWidth?: string
  minHeight?: string
  maxHeight?: string
  aspectRatio?: string
  boxSizing?: 'border-box' | 'content-box'

  // Spacing
  margin?: string
  marginTop?: string
  marginRight?: string
  marginBottom?: string
  marginLeft?: string
  padding?: string
  paddingTop?: string
  paddingRight?: string
  paddingBottom?: string
  paddingLeft?: string

  // Position
  position?: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky'
  top?: string
  right?: string
  bottom?: string
  left?: string
  zIndex?: number

  // Visual
  backgroundColor?: string
  background?: string
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  backgroundRepeat?: string
  objectFit?: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down'
  objectPosition?: string
  opacity?: number
  overflow?: string
  overflowX?: string
  overflowY?: string

  // Border
  border?: string
  borderTop?: string
  borderRight?: string
  borderBottom?: string
  borderLeft?: string
  borderRadius?: string
  borderTopLeftRadius?: string
  borderTopRightRadius?: string
  borderBottomLeftRadius?: string
  borderBottomRightRadius?: string
  outline?: string
  outlineOffset?: string

  // Effects
  boxShadow?: string
  filter?: string
  backdropFilter?: string
  transform?: string
  transformOrigin?: string

  // Motion
  transition?: string
  animation?: string

  // Interaction
  cursor?: string
  pointerEvents?: 'none' | 'auto'
  userSelect?: string

  // Scrollbar
  scrollBehavior?: string
}

/**
 * A named, reusable CSS class that can be assigned to any node.
 * Applied in the editor via `.mc-{id}` className; in the publisher via collectClassCSS().
 */
export interface CSSClass {
  id: string
  /** User-editable name — must be unique within the project */
  name: string
  description?: string
  /**
   * Optional ownership scope.
   * Missing scope means a normal reusable user class. Node-scoped classes are
   * internal instance style layers used by module CSS fields.
   */
  scope?: { type: 'node'; nodeId: string; role: 'module-style' }
  /** Base styles applied at all breakpoints */
  styles: Partial<CSSPropertyBag>
  /** Per-breakpoint overrides — key is Breakpoint.id */
  breakpointStyles: Record<string, Partial<CSSPropertyBag>>
  /** Optional tags for search/filtering in the Class Manager */
  tags?: string[]
  createdAt: number
  updatedAt: number
}

/**
 * A single element on the page — corresponds to exactly one ModuleDefinition.
 */
export interface PageNode {
  /** Unique ID — generated with nanoid() */
  id: string

  /**
   * References a ModuleDefinition in the registry.
   * Format: "namespace.module-name" — e.g. "base.heading"
   */
  moduleId: string

  /**
   * Resolved property values for this node's module.
   * Shape validated against ModuleDefinition.schema at runtime.
   * Keys are FLAT — no dot-path nesting.
   */
  props: Record<string, unknown>

  /**
   * Per-breakpoint prop overrides — shallow-merged on top of props when
   * rendering at a given breakpoint. Key is Breakpoint.id.
   */
  breakpointOverrides: Record<string, Partial<Record<string, unknown>>>

  /**
   * Ordered array of child node IDs.
   * Only meaningful when ModuleDefinition.canHaveChildren === true.
   * All children are in a single default slot (multi-slot deferred post-MVP).
   */
  children: string[]

  /** Optional user-facing label — overrides the module name in the DOM tree panel */
  label?: string

  /** When true, cannot be selected or moved in the editor */
  locked?: boolean

  /** When true, hidden on the canvas (still present in the tree) */
  hidden?: boolean

  /**
   * Ordered class IDs from the project's class registry.
   * Applied as className="mc-{id1} mc-{id2}" on the element.
   * Later classes in the array win in cascade order.
   * Defaults to [] when not present (backwards-compatible).
   */
  classIds?: string[]

  /**
   * VC-tree only: nested child PageNode objects for tree traversal.
   * Only populated on nodes inside a VisualComponent.rootNode tree.
   * Page nodes use the flat `nodes: Record<string, PageNode>` map instead.
   * Optional — absent on all standard Page nodes.
   */
  childNodes?: PageNode[]

  /**
   * VC-tree only: prop bindings for render-time parameter substitution.
   * Maps prop key → { paramId } (stable VCParam.id reference).
   * When present, the renderer substitutes instanceProps[param.name] for
   * the bound prop key at render time (Contribution #619 §4 Option β).
   * Optional — absent on all standard Page nodes and unbound VC nodes.
   */
  propBindings?: Record<string, { paramId: string }>
}

// ---------------------------------------------------------------------------
// Breakpoint
// ---------------------------------------------------------------------------

export interface Breakpoint {
  id: string
  /** Display label e.g. "Mobile", "Tablet", "Desktop" */
  label: string
  /** Viewport width in pixels */
  width: number
  /**
   * @motion/icons kebab-case icon name — e.g. "smartphone", "tablet", "monitor".
   * Rendered via <Icon name={bp.icon} /> in the editor UI.
   */
  icon: string
}

export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' },
  { id: 'tablet', label: 'Tablet', width: 768, icon: 'tablet' },
  { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
]

// ---------------------------------------------------------------------------
// Page — a single page in the project
// ---------------------------------------------------------------------------

export interface Page {
  id: string
  /** URL-safe slug — used as the filename in export and URL path when published */
  slug: string
  /** Display title e.g. "Home", "About Us" */
  title: string
  /**
   * FLAT MAP of all nodes on this page.
   * All mutations go through page-tree/mutations.ts.
   * Direct mutation outside Immer patches is forbidden (Constraint #182).
   */
  nodes: Record<string, PageNode>
  /**
   * ID of the root container node — always "base.root".
   * Entry point for all tree traversal and the publisher.
   */
  rootNodeId: string
}

// ---------------------------------------------------------------------------
// Project Settings
// ---------------------------------------------------------------------------

export interface TypeScale {
  /** Base font size in px — default 16 */
  baseSize: number
  /** Scale ratio e.g. 1.25 = Major Third, 1.333 = Perfect Fourth */
  ratio: number
}

export interface ProjectSettings {
  metaTitle?: string
  metaDescription?: string
  faviconUrl?: string
  /** Google Fonts @import URL */
  fontImportUrl?: string
  /**
   * BCP-47 language tag for the published HTML `lang` attribute — e.g. "en", "fr", "zh-Hant".
   * Defaults to "en" if omitted (WCAG 2.1 AA SC 3.1.1).
   */
  language?: string
  /** Global CSS custom property tokens (design tokens) */
  colorTokens: Record<string, string>
  typeScale: TypeScale
  /** Keyboard shortcut overrides: action → key combo string */
  shortcuts: Record<string, string>
}

export const DEFAULT_TYPE_SCALE: TypeScale = { baseSize: 16, ratio: 1.25 }

export const DEFAULT_COLOR_TOKENS: Record<string, string> = {
  '--color-primary': '#6366f1',
  '--color-secondary': '#8b5cf6',
  '--color-accent': '#ec4899',
  '--color-surface': '#ffffff',
  '--color-on-surface': '#0f172a',
  '--color-border': '#e2e8f0',
  '--color-muted': '#94a3b8',
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  colorTokens: DEFAULT_COLOR_TOKENS,
  typeScale: DEFAULT_TYPE_SCALE,
  shortcuts: {},
}

// ---------------------------------------------------------------------------
// Project — the top-level document
// ---------------------------------------------------------------------------

export interface Project {
  id: string
  name: string
  /**
   * Project output mode (Phase E).
   * - `'html'` (default): static HTML export via the existing publisher.
   * - `'react'`: JSX code-generation export via the ReactPublisher.
   *
   * This field is mutable post-creation (Architect message #1204).
   * When switching to 'react', a confirmation step warns if any placed
   * modules lack `toJsx()` (Guideline #305 / UX Reviewer).
   *
   * The Export dropdown always shows all three options (HTML / React / Astro)
   * regardless of projectMode (Architect decision: all options always available).
   */
  projectMode: 'html' | 'react'
  pages: Page[]
  /**
   * Flat list of every non-page file in the project.
   * (Contribution #595 §1 — files data layer)
   *
   * Pages are NOT stored here — they remain first-class in `pages[]` and are
   * exported into generated framework source files by the publisher.
   *
   * Why flat array: same reasoning as Page.nodes — O(1) path lookup via
   * getFileByPath(), single Immer reference per mutation, trivial serialization.
   * The display tree is derived via buildFileTree() in selectors.ts.
   *
   * Defaults to [] on hydration of legacy projects (validateProject handles this).
   */
  files: ProjectFile[]
  /**
   * User-authored reusable canvas trees.
   * Each VC is published as src/components/{Name}.tsx.
   * (Contribution #619 — Visual Components data layer)
   * Defaults to [] on hydration of legacy projects (validateProject handles this).
   */
  visualComponents: VisualComponent[]
  /**
   * Structured data model for managed Convex publishing.
   * Generated Convex files are build artifacts; the user-facing source is this
   * serialisable model of tables, fields, indexes, permissions, and seed data.
   */
  data: ProjectDataModel
  /**
   * Project-owned package manifest used by the Files panel and React export.
   * Optional for legacy fixtures/projects; validation and project creation fill
   * defaults before normal editor use.
   */
  packageJson?: ProjectPackageJson
  breakpoints: Breakpoint[]
  settings: ProjectSettings
  /**
   * Global class registry — flat map of all CSSClass definitions for this project.
   * Key is CSSClass.id (nanoid). Applied to nodes via node.classIds[].
   */
  classes: Record<string, CSSClass>
  createdAt: number
  updatedAt: number
}
