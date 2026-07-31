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
 * Two provider-boundary constraints intentionally add a second validation
 * layer in the browser executor:
 *
 *   - `render_snapshot` adds the server-set `captureScreenshot` flag on top of
 *     the model-facing `RenderSnapshotInputSchema`.
 *   - `site_apply_css` advertises one flat object because Anthropic rejects
 *     `anyOf`/`oneOf`/`allOf` at a tool schema's root. The executor validates
 *     that object against `ApplyCssExecutionInputSchema`, the exact
 *     discriminated union. Both schemas reuse the field definitions below.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// Document refs
// ---------------------------------------------------------------------------

export const AgentDocumentRefSchema = Type.Union([
  Type.Object({
    type: Type.Literal('page'),
    id: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    type: Type.Literal('template'),
    id: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    type: Type.Literal('visualComponent'),
    id: Type.String({ minLength: 1 }),
  }),
])
export type AgentDocumentRef = Static<typeof AgentDocumentRefSchema>

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

export const ReadDocumentInputSchema = Type.Object({
  document: Type.Optional(AgentDocumentRefSchema),
  part: Type.Optional(Type.Integer({ minimum: 1 })),
})
export type ReadDocumentInput = Static<typeof ReadDocumentInputSchema>

export const OpenDocumentInputSchema = Type.Object({
  document: AgentDocumentRefSchema,
})
export type OpenDocumentInput = Static<typeof OpenDocumentInputSchema>

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

const CssTextInputSchema = Type.String({
  minLength: 1,
  description: 'Required for merge and replace. Contains complete CSS rules, including their selectors.',
})
const CssSelectorListInputSchema = Type.Array(
  Type.String({ minLength: 1 }),
  {
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    description: 'Required for delete and remove-properties. Each entry is one exact emitted selector.',
  },
)
const CssPropertyNameInputSchema = Type.String({
  minLength: 1,
  pattern: '^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$',
})
const CssPropertyListInputSchema = Type.Array(
  CssPropertyNameInputSchema,
  {
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    description: 'Required only for remove-properties. Names use CSS kebab-case, including vendor/custom properties.',
  },
)
const CssMergeOperationSchema = Type.Literal('merge')
const CssReplaceOperationSchema = Type.Literal('replace')
const CssDeleteOperationSchema = Type.Literal('delete')
const CssRemovePropertiesOperationSchema = Type.Literal('remove-properties')
const CssOperationSchema = Type.Union([
  CssMergeOperationSchema,
  CssReplaceOperationSchema,
  CssDeleteOperationSchema,
  CssRemovePropertiesOperationSchema,
], {
  description: 'The CSS mutation to perform. Its required companion fields are documented on css, selectors, and properties.',
})

/**
 * Provider-facing tool schema. Tool providers require an ordinary object at
 * the root, and Anthropic explicitly rejects root-level schema composition.
 * The descriptions state each operation's required fields; the browser then
 * enforces the exact discriminated shape with ApplyCssExecutionInputSchema.
 */
export const ApplyCssInputSchema = Type.Object({
  operation: CssOperationSchema,
  css: Type.Optional(CssTextInputSchema),
  selectors: Type.Optional(CssSelectorListInputSchema),
  properties: Type.Optional(CssPropertyListInputSchema),
}, { additionalProperties: false })

/**
 * Exact CSS-registry mutation accepted at the editor-store boundary. The
 * discriminator keeps destructive replacement/deletion impossible to trigger
 * accidentally by omitting an optional field from a normal merge.
 */
export const ApplyCssExecutionInputSchema = Type.Union([
  Type.Object({
    operation: CssMergeOperationSchema,
    css: CssTextInputSchema,
  }),
  Type.Object({
    operation: CssReplaceOperationSchema,
    css: CssTextInputSchema,
  }),
  Type.Object({
    operation: CssDeleteOperationSchema,
    selectors: CssSelectorListInputSchema,
  }),
  Type.Object({
    operation: CssRemovePropertiesOperationSchema,
    selectors: CssSelectorListInputSchema,
    properties: CssPropertyListInputSchema,
  }),
])
export type ApplyCssInput = Static<typeof ApplyCssInputSchema>
export type ApplyCssExecutionInput = Static<typeof ApplyCssExecutionInputSchema>

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
// Code asset tools
// ---------------------------------------------------------------------------

const CodeAssetTypeSchema = Type.Union([
  Type.Literal('script'),
  Type.Literal('style'),
])

const CodeAssetRefInputSchema = Type.Object({
  fileId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.Optional(Type.String({ minLength: 1 })),
})

export const ListCodeAssetsInputSchema = Type.Object({
  type: Type.Optional(CodeAssetTypeSchema),
})
export type ListCodeAssetsInput = Static<typeof ListCodeAssetsInputSchema>

export const ReadCodeAssetInputSchema = Type.Composite([
  CodeAssetRefInputSchema,
  Type.Object({
    part: Type.Optional(Type.Integer({ minimum: 1 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  }),
])
export type ReadCodeAssetInput = Static<typeof ReadCodeAssetInputSchema>

export const WriteCodeAssetInputSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  type: CodeAssetTypeSchema,
  content: Type.String(),
  runtime: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  dependencies: Type.Optional(Type.Record(
    Type.String(),
    Type.String({ minLength: 1 }),
    {
      description:
        'Runtime npm dependencies required by a module script. Keys are package names, values are semver versions/ranges. Only valid when type is "script".',
    },
  )),
})
export type WriteCodeAssetInput = Static<typeof WriteCodeAssetInputSchema>

export const PatchCodeAssetInputSchema = Type.Composite([
  CodeAssetRefInputSchema,
  Type.Object({
    expectedHash: Type.String({ minLength: 1 }),
    replacements: Type.Array(
      Type.Object({
        oldText: Type.String({ minLength: 1 }),
        newText: Type.String(),
        replaceAll: Type.Optional(Type.Boolean()),
      }),
      { minItems: 1 },
    ),
  }),
])
export type PatchCodeAssetInput = Static<typeof PatchCodeAssetInputSchema>

export const InspectCodeRuntimeInputSchema = Type.Object({
  document: Type.Optional(AgentDocumentRefSchema),
})
export type InspectCodeRuntimeInput = Static<typeof InspectCodeRuntimeInputSchema>

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
