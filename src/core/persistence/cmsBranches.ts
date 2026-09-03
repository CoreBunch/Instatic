/**
 * Client-side persistence layer for site branches:
 *   GET    /admin/api/cms/branches
 *   POST   /admin/api/cms/branches
 *   PATCH  /admin/api/cms/branches/:id
 *   DELETE /admin/api/cms/branches/:id
 *
 * These calls address the registry, not a branch's content, so they never
 * depend on the active-branch header (the server ignores it here).
 */
import { apiRequest } from '@core/http'
import {
  ApplyMergeEnvelopeSchema,
  BranchEnvelopeSchema,
  BranchListEnvelopeSchema,
  BranchPreviewLinkEnvelopeSchema,
  BranchPreviewStateEnvelopeSchema,
  MergePlanEnvelopeSchema,
  type ApplyMergeBody,
  type BranchPreview,
  type CreateBranchBody,
  type MergeDirection,
  type MergePlan,
  type RenameBranchBody,
  type SiteBranch,
} from '@core/branches'

const BRANCHES_PATH = '/admin/api/cms/branches'

export async function listCmsBranches(signal?: AbortSignal): Promise<SiteBranch[]> {
  const payload = await apiRequest(BRANCHES_PATH, {
    schema: BranchListEnvelopeSchema,
    signal,
    fallbackMessage: 'Failed to load branches',
  })
  return payload.branches
}

export async function createCmsBranch(body: CreateBranchBody): Promise<SiteBranch> {
  const payload = await apiRequest(BRANCHES_PATH, {
    method: 'POST',
    body,
    schema: BranchEnvelopeSchema,
    fallbackMessage: 'Failed to create branch',
  })
  return payload.branch
}

export async function renameCmsBranch(id: string, body: RenameBranchBody): Promise<SiteBranch> {
  const payload = await apiRequest(`${BRANCHES_PATH}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: BranchEnvelopeSchema,
    fallbackMessage: 'Failed to rename branch',
  })
  return payload.branch
}

export async function deleteCmsBranch(id: string): Promise<void> {
  await apiRequest(`${BRANCHES_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fallbackMessage: 'Failed to delete branch',
  })
}

export async function getCmsBranchPreview(id: string): Promise<BranchPreview | null> {
  const payload = await apiRequest(`${BRANCHES_PATH}/${encodeURIComponent(id)}/preview`, {
    schema: BranchPreviewStateEnvelopeSchema,
    fallbackMessage: 'Failed to load the preview link',
  })
  return payload.preview
}

/** Issue a fresh preview link (retiring the previous one) and return its URL. */
export async function issueCmsBranchPreview(id: string): Promise<{ url: string; preview: BranchPreview }> {
  return apiRequest(`${BRANCHES_PATH}/${encodeURIComponent(id)}/preview`, {
    method: 'POST',
    schema: BranchPreviewLinkEnvelopeSchema,
    fallbackMessage: 'Failed to create the preview link',
  })
}

export async function revokeCmsBranchPreview(id: string): Promise<void> {
  await apiRequest(`${BRANCHES_PATH}/${encodeURIComponent(id)}/preview`, {
    method: 'DELETE',
    fallbackMessage: 'Failed to revoke the preview link',
  })
}

export async function getCmsBranchMergePlan(id: string, direction: MergeDirection): Promise<MergePlan> {
  const payload = await apiRequest(`${BRANCHES_PATH}/${encodeURIComponent(id)}/${direction}`, {
    schema: MergePlanEnvelopeSchema,
    fallbackMessage: direction === 'merge' ? 'Failed to plan the merge' : 'Failed to plan the update',
  })
  return payload.plan
}

export async function applyCmsBranchMerge(
  id: string,
  direction: MergeDirection,
  body: ApplyMergeBody,
): Promise<{ plan: MergePlan; branchDeleted: boolean }> {
  return apiRequest(`${BRANCHES_PATH}/${encodeURIComponent(id)}/${direction}`, {
    method: 'POST',
    body,
    schema: ApplyMergeEnvelopeSchema,
    fallbackMessage: direction === 'merge' ? 'Failed to merge the branch' : 'Failed to update the branch',
  })
}
