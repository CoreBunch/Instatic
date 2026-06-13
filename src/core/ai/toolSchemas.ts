/**
 * AI site write-tool INPUT schemas — the single source of truth.
 *
 * These TypeBox schemas define the input shape of every browser-bridged site
 * write tool. They are consumed by BOTH sides of the bridge:
 *
 *   - `server/ai/tools/site/writeTools.ts` uses each schema as the tool's
 *     `inputSchema` (the model-facing JSON Schema the driver advertises).
 *   - `src/admin/pages/site/agent/executor.ts` + `tokenRunners.ts` validate
 *     the incoming `toolRequest` payload with `parseValue(schema, raw)` before
 *     applying the mutation against the editor store.
 *
 * Before this leaf existed the schemas were declared THREE times (server tools,
 * executor, token runners) and silently drifted. Now they live here once: a
 * server-side constraint and the browser-side validation can never disagree,
 * and adding a required field breaks both consumers at build time.
 *
 * This module is a pure, dependency-free leaf — TypeBox only, no server- or
 * browser-runtime imports — so both `server/` and `src/admin/` may import it
 * (mirrors `@core/css-sanitize` / `@core/framework-schema`). Keep it that way.
 *
 * `render_snapshot` is the one legitimate divergence: the model-facing schema
 * (`RenderSnapshotInputSchema`) exposes only `breakpointId`/`nodeId`, while the
 * executor adds a server-set `captureScreenshot` flag on top — see that schema
 * and the executor's composed `renderSnapshotInputSchema`.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// HTML-native write tools
// ---------------------------------------------------------------------------

export const InsertHtmlInputSchema = Type.Object({
  parentId: Type.String({ minLength: 1 }),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  html: Type.String({ minLength: 1 }),
})
export type InsertHtmlInput = Static<typeof InsertHtmlInputSchema>

export const GetNodeHtmlInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
})
export type GetNodeHtmlInput = Static<typeof GetNodeHtmlInputSchema>

export const ReplaceNodeHtmlInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  html: Type.String({ minLength: 1 }),
})
export type ReplaceNodeHtmlInput = Static<typeof ReplaceNodeHtmlInputSchema>

// ---------------------------------------------------------------------------
// Node-level write tools
// ---------------------------------------------------------------------------

export const DeleteNodeInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
})
export type DeleteNodeInput = Static<typeof DeleteNodeInputSchema>

export const UpdateNodePropsInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  patch: Type.Record(Type.String(), Type.Unknown()),
})
export type UpdateNodePropsInput = Static<typeof UpdateNodePropsInputSchema>

export const MoveNodeInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  newParentId: Type.String({ minLength: 1 }),
  newIndex: Type.Integer({ minimum: 0 }),
})
export type MoveNodeInput = Static<typeof MoveNodeInputSchema>

export const RenameNodeInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
})
export type RenameNodeInput = Static<typeof RenameNodeInputSchema>

export const DuplicateNodeInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
})
export type DuplicateNodeInput = Static<typeof DuplicateNodeInputSchema>

// ---------------------------------------------------------------------------
// CSS + class-assignment write tools
// ---------------------------------------------------------------------------

export const ApplyCssInputSchema = Type.Object({
  css: Type.String({ minLength: 1 }),
})
export type ApplyCssInput = Static<typeof ApplyCssInputSchema>

export const AssignClassInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  classId: Type.String({ minLength: 1 }),
})
export type AssignClassInput = Static<typeof AssignClassInputSchema>

export const RemoveClassInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  classId: Type.String({ minLength: 1 }),
})
export type RemoveClassInput = Static<typeof RemoveClassInputSchema>

// ---------------------------------------------------------------------------
// Page-level write tools
// ---------------------------------------------------------------------------

export const AddPageInputSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})
export type AddPageInput = Static<typeof AddPageInputSchema>

export const DeletePageInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
})
export type DeletePageInput = Static<typeof DeletePageInputSchema>

export const RenamePageInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})
export type RenamePageInput = Static<typeof RenamePageInputSchema>

export const DuplicatePageInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})
export type DuplicatePageInput = Static<typeof DuplicatePageInputSchema>

// ---------------------------------------------------------------------------
// Template write tools
//
// The target shape intentionally matches `TemplateTargetSchema` in
// `@core/page-tree`; it is redefined here (not imported) to keep this module a
// dependency-free leaf rather than pulling in the page-tree engine.
// ---------------------------------------------------------------------------

const TemplateTargetInputSchema = Type.Union([
  Type.Object({ kind: Type.Literal('everywhere') }),
  Type.Object({
    kind: Type.Literal('postTypes'),
    tableSlugs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }),
  Type.Object({ kind: Type.Literal('notFound') }),
])

export const SetPageTemplateInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  target: TemplateTargetInputSchema,
  priority: Type.Optional(Type.Number()),
})
export type SetPageTemplateInput = Static<typeof SetPageTemplateInputSchema>

export const ClearPageTemplateInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
})
export type ClearPageTemplateInput = Static<typeof ClearPageTemplateInputSchema>

// ---------------------------------------------------------------------------
// Design-system token write tools
//
// Colors and fonts are LIST-shaped (one entry per token); typography and
// spacing are SCALE-shaped (a group config from which the framework generates
// per-step values).
// ---------------------------------------------------------------------------

export const SetColorTokensInputSchema = Type.Object({
  tokens: Type.Array(
    Type.Object({
      slug: Type.String({ minLength: 1 }),
      lightValue: Type.String({ minLength: 1 }),
      category: Type.Optional(Type.String()),
      darkValue: Type.Optional(Type.String()),
      darkModeEnabled: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1 },
  ),
})

export const SetFontTokensInputSchema = Type.Object({
  tokens: Type.Array(
    Type.Object({
      name: Type.String({ minLength: 1 }),
      variable: Type.Optional(Type.String()),
      fallback: Type.Optional(Type.String()),
      googleFamily: Type.Optional(Type.String()),
      variants: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      subsets: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      familyId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    { minItems: 1 },
  ),
})

/** A single scale anchor (min/max breakpoint) — `fontSize` for type, `size` for spacing. */
const ScaleBreakpointInputSchema = (sizeKey: 'fontSize' | 'size') =>
  Type.Object({
    [sizeKey]: Type.Optional(Type.Number()),
    scaleRatio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  })

export const SetTypeScaleInputSchema = Type.Object({
  groupId: Type.Optional(Type.String({ minLength: 1 })),
  namingConvention: Type.Optional(Type.String({ minLength: 1 })),
  steps: Type.Optional(Type.String({ minLength: 1 })),
  baseScaleIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  min: Type.Optional(ScaleBreakpointInputSchema('fontSize')),
  max: Type.Optional(ScaleBreakpointInputSchema('fontSize')),
})

export const SetSpacingScaleInputSchema = Type.Object({
  groupId: Type.Optional(Type.String({ minLength: 1 })),
  namingConvention: Type.Optional(Type.String({ minLength: 1 })),
  steps: Type.Optional(Type.String({ minLength: 1 })),
  baseScaleIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  min: Type.Optional(ScaleBreakpointInputSchema('size')),
  max: Type.Optional(ScaleBreakpointInputSchema('size')),
})

// ---------------------------------------------------------------------------
// render_snapshot
//
// MODEL-FACING shape only — `breakpointId`/`nodeId`. The browser executor
// composes a server-set `captureScreenshot` flag on top of this (non-vision
// models skip the expensive html-to-image capture); the model never sets it,
// so it stays out of the advertised tool schema.
// ---------------------------------------------------------------------------

export const RenderSnapshotInputSchema = Type.Object({
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  nodeId: Type.Optional(Type.String({ minLength: 1 })),
})
