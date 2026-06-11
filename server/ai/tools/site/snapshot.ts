/**
 * Site-scope snapshot types.
 *
 * `SiteAgentSnapshot` is the raw authoritative tree the browser posts each turn
 * (the chat handler hands it to site-scope tool handlers via
 * `ToolContext.snapshot`). It is defined alongside its browser serializer in
 * `@site/agent/siteAgentSnapshot` and re-exported here as the canonical
 * server-side name.
 *
 * The remaining types are tool RESULT contracts: the module/token catalog
 * shapes `read`-surface tools (`list_modules`, `list_tokens`) return. They are
 * produced server-side by `render.ts` from the registry + posted site.
 */

export { SiteAgentSnapshotSchema } from '@site/agent/siteAgentSnapshot'
export type { SiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'

/**
 * The site's design tokens, surfaced so the agent references the design system
 * (`var(--primary)`, `class="text-l text-primary"`) instead of hardcoding
 * off-brand colors, sizes, and fonts. Built by `describeAgentTokens` from
 * `describeFrameworkTokens` + `describeFontTokens`.
 */
export interface SnapshotTokens {
  colors: SnapshotColorToken[]
  typography: SnapshotScaleGroup[]
  spacing: SnapshotScaleGroup[]
  fonts: SnapshotFontToken[]
}

interface SnapshotTokenRef {
  /** CSS custom property incl. leading dashes, e.g. "--primary". */
  cssVar: string
  /** `var(--…)` expression ready to drop into a style value. */
  ref: string
  /** Resolved value (light theme / min breakpoint). */
  value: string
  /** Utility class names bound to this token, e.g. ["text-primary","bg-primary"]. */
  utilityClasses: string[]
}

interface SnapshotColorVariant extends SnapshotTokenRef {
  /** Variant label, e.g. "d-1" (shade), "l-2" (tint), "30" (transparent). */
  variant: string
}

interface SnapshotColorToken extends SnapshotTokenRef {
  slug: string
  category: string
  darkValue?: string
  variants: SnapshotColorVariant[]
}

interface SnapshotScaleStep extends SnapshotTokenRef {
  /** Step label, e.g. "xs","m","2xl". */
  step: string
}

interface SnapshotScaleGroup {
  id: string
  family: 'typography' | 'spacing'
  name: string
  /** Variable/class naming convention, e.g. "text" or "space". */
  namingConvention: string
  steps: SnapshotScaleStep[]
}

interface SnapshotFontToken {
  name: string
  cssVar: string
  ref: string
  /** Resolved installed family, or "" for a fallback-only token. */
  family: string
  /** Full resolved font-family stack, e.g. `"Inter", sans-serif`. */
  stack: string
}

export interface ModuleInfo {
  id: string
  name: string
  description?: string
  category: string
  canHaveChildren: boolean
  defaults: Record<string, unknown>
  props: ModulePropInfo[]
  styles: ModuleStyleInfo[]
}

export interface ModulePropInfo {
  key: string
  type: string
  label: string
  description?: string
  defaultValue?: unknown
  options?: Array<{ label: string; value: unknown }>
  breakpointOverridable?: boolean
}

export interface ModuleStyleInfo {
  key: string
  type: string
  label: string
  description?: string
  defaultValue?: unknown
  cssProperties: string[]
  options?: Array<{ label: string; value: unknown }>
}
