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

export const MergeChangeSchema = Type.Object({
  key: Type.String(),
  kind: Type.Union([Type.Literal('row'), Type.Literal('table'), Type.Literal('site')]),
  logicalId: Type.String(),
  label: Type.String(),
  tableId: Type.Union([Type.String(), Type.Null()]),
  tableName: Type.Union([Type.String(), Type.Null()]),
  action: Type.Union([Type.Literal('create'), Type.Literal('update'), Type.Literal('delete')]),
  conflicts: Type.Array(Type.String()),
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

export const ApplyMergeEnvelopeSchema = Type.Object({
  plan: MergePlanSchema,
  branchDeleted: Type.Boolean(),
})
