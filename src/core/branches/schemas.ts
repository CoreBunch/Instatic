/**
 * Wire shapes shared by the branch endpoints and the admin client. TypeBox
 * is the source of truth; every type below is derived from its schema.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { BRANCH_NAME_MAX_LENGTH } from './ids'

export const SiteBranchSchema = Type.Object({
  /** Branch slug — immutable, part of every physical row id off `main`. */
  id: Type.String(),
  /** Display name; editable. */
  name: Type.String(),
  /** Branch this one was forked from, `null` for `main`. */
  baseBranchId: Type.Union([Type.String(), Type.Null()]),
  createdByUserId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})
export type SiteBranch = Static<typeof SiteBranchSchema>

export const BranchListEnvelopeSchema = Type.Object({
  branches: Type.Array(SiteBranchSchema),
})
export type BranchListEnvelope = Static<typeof BranchListEnvelopeSchema>

export const BranchEnvelopeSchema = Type.Object({
  branch: SiteBranchSchema,
})

export const CreateBranchBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: BRANCH_NAME_MAX_LENGTH }),
  /** Explicit slug; derived from `name` when omitted. */
  id: Type.Optional(Type.String()),
  /** Branch to fork; defaults to `main`. */
  fromBranchId: Type.Optional(Type.String()),
}, { additionalProperties: false })
export type CreateBranchBody = Static<typeof CreateBranchBodySchema>

export const RenameBranchBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: BRANCH_NAME_MAX_LENGTH }),
}, { additionalProperties: false })
export type RenameBranchBody = Static<typeof RenameBranchBodySchema>

/** An issued preview link. The token itself is only ever returned at creation. */
export const BranchPreviewSchema = Type.Object({
  id: Type.String(),
  branchId: Type.String(),
  createdByUserId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})
export type BranchPreview = Static<typeof BranchPreviewSchema>

export const BranchPreviewStateEnvelopeSchema = Type.Object({
  preview: Type.Union([BranchPreviewSchema, Type.Null()]),
})

export const BranchPreviewLinkEnvelopeSchema = Type.Object({
  url: Type.String(),
  preview: BranchPreviewSchema,
})

// ---------------------------------------------------------------------------
// Merge / update plans
// ---------------------------------------------------------------------------

export const MergeDirectionSchema = Type.Union([Type.Literal('merge'), Type.Literal('update')])
export type MergeDirection = Static<typeof MergeDirectionSchema>

export const MergeResolutionSchema = Type.Union([Type.Literal('into'), Type.Literal('from')])
export type MergeResolution = Static<typeof MergeResolutionSchema>

export const MergeEntityKindSchema = Type.Union([
  Type.Literal('row'),
  Type.Literal('table'),
  Type.Literal('site'),
  Type.Literal('file'),
])
export type MergeEntityKind = Static<typeof MergeEntityKindSchema>

/** One field that differs between the two sides, as display text. */
export const MergeFieldChangeSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  /** Value on the receiving side (`into`), null when absent there. */
  before: Type.Union([Type.String(), Type.Null()]),
  /** Value on the contributing side (`from`), null when absent there. */
  after: Type.Union([Type.String(), Type.Null()]),
  /** True when either value is an object or array shown as a JSON preview. */
  structured: Type.Boolean(),
  /** True when this field is one both sides changed differently. */
  conflict: Type.Boolean(),
})
export type MergeFieldChange = Static<typeof MergeFieldChangeSchema>

/** Node-level diff of a page tree, keyed by node id (what the review highlights). */
export const MergeTreeDiffSchema = Type.Object({
  added: Type.Array(Type.String()),
  changed: Type.Array(Type.String()),
  removed: Type.Array(Type.String()),
  /** Human label per node id that appears above. */
  labels: Type.Record(Type.String(), Type.String()),
  /** For each changed node, what moved: `text: “old” → “new”`, `hidden changed`, … */
  details: Type.Record(Type.String(), Type.Array(Type.String())),
})
export type MergeTreeDiff = Static<typeof MergeTreeDiffSchema>

export const MergeSchemaFieldSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  type: Type.String(),
  status: Type.Union([
    Type.Literal('new'),
    Type.Literal('changed'),
    Type.Literal('removed'),
    Type.Literal('same'),
  ]),
})
export type MergeSchemaField = Static<typeof MergeSchemaFieldSchema>

/**
 * What a change looks like, per entity kind — enough for the review to draw
 * a field table, a schema list, a file diff, or page highlights without a
 * second request.
 */
export const MergeChangeDetailSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('row'),
    fields: Type.Array(MergeFieldChangeSchema),
    /** Present for rows whose `body` cell is a node tree (pages, components, layouts). */
    tree: Type.Union([MergeTreeDiffSchema, Type.Null()]),
  }),
  Type.Object({
    kind: Type.Literal('table'),
    fields: Type.Array(MergeFieldChangeSchema),
    schema: Type.Array(MergeSchemaFieldSchema),
  }),
  Type.Object({
    kind: Type.Literal('site'),
    fields: Type.Array(MergeFieldChangeSchema),
  }),
  Type.Object({
    kind: Type.Literal('file'),
    path: Type.String(),
    /** The path on the receiving side when the file was renamed. */
    pathBefore: Type.Union([Type.String(), Type.Null()]),
    fileType: Type.String(),
    before: Type.Union([Type.String(), Type.Null()]),
    after: Type.Union([Type.String(), Type.Null()]),
    /** Asset files carry no text; the review shows metadata only. */
    binary: Type.Boolean(),
  }),
])
export type MergeChangeDetail = Static<typeof MergeChangeDetailSchema>

export const MergeChangeSchema = Type.Object({
  key: Type.String(),
  kind: MergeEntityKindSchema,
  logicalId: Type.String(),
  label: Type.String(),
  tableId: Type.Union([Type.String(), Type.Null()]),
  tableName: Type.Union([Type.String(), Type.Null()]),
  action: Type.Union([Type.Literal('create'), Type.Literal('update'), Type.Literal('delete')]),
  conflicts: Type.Array(Type.String()),
  detail: MergeChangeDetailSchema,
})
export type MergeChange = Static<typeof MergeChangeSchema>

export const MergePlanSchema = Type.Object({
  branchId: Type.String(),
  direction: MergeDirectionSchema,
  from: Type.String(),
  into: Type.String(),
  changes: Type.Array(MergeChangeSchema),
  conflictCount: Type.Number(),
})
export type MergePlan = Static<typeof MergePlanSchema>

export const MergePlanEnvelopeSchema = Type.Object({ plan: MergePlanSchema })

export const ApplyMergeBodySchema = Type.Object({
  resolutions: Type.Optional(Type.Record(Type.String(), MergeResolutionSchema)),
  /** Merge only: delete the branch once its changes are on main. */
  deleteBranch: Type.Optional(Type.Boolean()),
})
export type ApplyMergeBody = Static<typeof ApplyMergeBodySchema>

/**
 * One applied merge or update, kept so it can be undone. The server holds
 * what every touched entity looked like before; the client sees only the
 * record. `undoneAt` is set once it has been reversed.
 */
export const BranchMergeRecordSchema = Type.Object({
  id: Type.String(),
  branchId: Type.String(),
  direction: MergeDirectionSchema,
  appliedByUserId: Type.Union([Type.String(), Type.Null()]),
  changeCount: Type.Integer(),
  createdAt: Type.String(),
  undoneAt: Type.Union([Type.String(), Type.Null()]),
})
export type BranchMergeRecord = Static<typeof BranchMergeRecordSchema>

export const ApplyMergeEnvelopeSchema = Type.Object({
  plan: MergePlanSchema,
  branchDeleted: Type.Boolean(),
  /** The record to undo by; null when the branch was deleted with the merge. */
  merge: Type.Union([BranchMergeRecordSchema, Type.Null()]),
})
export type ApplyMergeEnvelope = Static<typeof ApplyMergeEnvelopeSchema>

export const UndoMergeEnvelopeSchema = Type.Object({
  merge: BranchMergeRecordSchema,
  /** Entities put back the way they were. */
  restoredCount: Type.Integer(),
})
export type UndoMergeEnvelope = Static<typeof UndoMergeEnvelopeSchema>

// ---------------------------------------------------------------------------
// Merge review — requests and comments on a branch
// ---------------------------------------------------------------------------

export const ReviewUserLabelSchema = Type.Object({
  id: Type.String(),
  displayName: Type.String(),
  email: Type.String(),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
  gravatarHash: Type.String(),
})
export type ReviewUserLabel = Static<typeof ReviewUserLabelSchema>

export const MergeRequestStatusSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('declined'),
  Type.Literal('merged'),
  Type.Literal('withdrawn'),
])
export type MergeRequestStatus = Static<typeof MergeRequestStatusSchema>

export const BranchMergeRequestSchema = Type.Object({
  id: Type.String(),
  branchId: Type.String(),
  requestedBy: Type.Union([ReviewUserLabelSchema, Type.Null()]),
  note: Type.String(),
  /** Hash of the branch's content when the request was made — stale detection. */
  contentHash: Type.String(),
  status: MergeRequestStatusSchema,
  resolvedBy: Type.Union([ReviewUserLabelSchema, Type.Null()]),
  resolvedAt: Type.Union([Type.String(), Type.Null()]),
  resolutionNote: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})
export type BranchMergeRequest = Static<typeof BranchMergeRequestSchema>

/** Comments attach to the request itself (`entityKey: ''`) or to one change key. */
export const BranchReviewCommentSchema = Type.Object({
  id: Type.String(),
  branchId: Type.String(),
  requestId: Type.Union([Type.String(), Type.Null()]),
  entityKey: Type.String(),
  author: Type.Union([ReviewUserLabelSchema, Type.Null()]),
  body: Type.String(),
  createdAt: Type.String(),
})
export type BranchReviewComment = Static<typeof BranchReviewCommentSchema>

export const BranchReviewStateSchema = Type.Object({
  branch: SiteBranchSchema,
  request: Type.Union([BranchMergeRequestSchema, Type.Null()]),
  comments: Type.Array(BranchReviewCommentSchema),
  /** Hash of the branch's content right now (compare with `request.contentHash`). */
  contentHash: Type.String(),
  /** The newest merge into main that has not been undone, if any. */
  lastMerge: Type.Union([BranchMergeRecordSchema, Type.Null()]),
})
export type BranchReviewState = Static<typeof BranchReviewStateSchema>

export const REVIEW_NOTE_MAX_LENGTH = 2000
export const REVIEW_COMMENT_MAX_LENGTH = 4000
/**
 * The desktop viewport the review's page frames stand for: the frame is
 * laid out this wide, and the server resolves viewport units against it.
 */
export const REVIEW_VIEWPORT = { width: 1280, height: 800 } as const

export const CreateMergeRequestBodySchema = Type.Object({
  note: Type.String({ maxLength: REVIEW_NOTE_MAX_LENGTH }),
}, { additionalProperties: false })
export type CreateMergeRequestBody = Static<typeof CreateMergeRequestBodySchema>

export const DeclineMergeRequestBodySchema = Type.Object({
  note: Type.String({ minLength: 1, maxLength: REVIEW_NOTE_MAX_LENGTH }),
}, { additionalProperties: false })
export type DeclineMergeRequestBody = Static<typeof DeclineMergeRequestBodySchema>

export const CreateReviewCommentBodySchema = Type.Object({
  entityKey: Type.String({ maxLength: 400 }),
  body: Type.String({ minLength: 1, maxLength: REVIEW_COMMENT_MAX_LENGTH }),
}, { additionalProperties: false })
export type CreateReviewCommentBody = Static<typeof CreateReviewCommentBodySchema>

export const ReviewCommentEnvelopeSchema = Type.Object({ comment: BranchReviewCommentSchema })
export const MergeRequestEnvelopeSchema = Type.Object({ request: BranchMergeRequestSchema })

export const ReviewRenderSideSchema = Type.Union([Type.Literal('main'), Type.Literal('branch')])
export type ReviewRenderSide = Static<typeof ReviewRenderSideSchema>
