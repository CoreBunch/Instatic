/**
 * @core/branches — branch identity, id scheme, and wire schemas shared by the
 * server, the admin client, and the collab engine. Barrel-gated: import ONLY
 * from `@core/branches` outside this folder.
 */
export {
  BRANCH_ID_PATTERN,
  BRANCH_NAME_MAX_LENGTH,
  MAIN_BRANCH_ID,
  SITE_SHELL_LOGICAL_ID,
  isMainBranch,
  isValidBranchId,
  logicalIdOf,
  physicalId,
  slugifyBranchName,
} from './ids'
export { jsonEquals, mergeJson, type JsonMergeResult } from './threeWayMerge'
export {
  BranchEnvelopeSchema,
  BranchListEnvelopeSchema,
  BranchPreviewLinkEnvelopeSchema,
  BranchPreviewSchema,
  BranchPreviewStateEnvelopeSchema,
  CreateBranchBodySchema,
  RenameBranchBodySchema,
  SiteBranchSchema,
  ApplyMergeBodySchema,
  ApplyMergeEnvelopeSchema,
  MergeChangeSchema,
  MergeDirectionSchema,
  MergePlanEnvelopeSchema,
  MergePlanSchema,
  MergeResolutionSchema,
  type ApplyMergeBody,
  type BranchListEnvelope,
  type BranchPreview,
  type CreateBranchBody,
  type MergeChange,
  type MergeDirection,
  type MergePlan,
  type MergeResolution,
  type RenameBranchBody,
  type SiteBranch,
} from './schemas'
