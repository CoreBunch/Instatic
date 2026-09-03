/**
 * The merge review's data: the merge plan (every change, with detail) and
 * the review state (request, comments, current content hash), plus the
 * actions that move them. Loaded together; each action updates the local
 * copy from the server's response so the page never guesses.
 */
import { useEffect, useState } from 'react'
import type { BranchMergeRequest, BranchReviewComment, BranchReviewState, MergePlan } from '@core/branches'
import { isAbortError } from '@core/http'
import {
  addCmsBranchReviewComment,
  declineCmsBranchMergeRequest,
  getCmsBranchMergePlan,
  getCmsBranchReview,
  requestCmsBranchMerge,
  withdrawCmsBranchMergeRequest,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'

export interface BranchReviewData {
  plan: MergePlan | null
  review: BranchReviewState | null
  loadError: string | null
  /** Re-fetch both the plan and the review state. */
  reload: () => Promise<void>
  request: (note: string) => Promise<BranchMergeRequest>
  withdraw: () => Promise<BranchMergeRequest>
  decline: (note: string) => Promise<BranchMergeRequest>
  comment: (entityKey: string, body: string) => Promise<BranchReviewComment>
}

async function fetchReviewData(
  branchId: string,
  signal?: AbortSignal,
): Promise<{ plan: MergePlan; review: BranchReviewState }> {
  const [plan, review] = await Promise.all([
    getCmsBranchMergePlan(branchId, 'merge'),
    getCmsBranchReview(branchId, signal),
  ])
  return { plan, review }
}

export function useBranchReview(branchId: string): BranchReviewData {
  const [plan, setPlan] = useState<MergePlan | null>(null)
  const [review, setReview] = useState<BranchReviewState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchReviewData(branchId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setPlan(next.plan)
        setReview(next.review)
        setLoadError(null)
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return
        console.error('[branch-review] load failed:', err)
        setLoadError(getErrorMessage(err, 'Could not load the review'))
      })
    return () => controller.abort()
  }, [branchId])

  async function reload(): Promise<void> {
    try {
      const next = await fetchReviewData(branchId)
      setPlan(next.plan)
      setReview(next.review)
      setLoadError(null)
    } catch (err) {
      console.error('[branch-review] reload failed:', err)
      setLoadError(getErrorMessage(err, 'Could not load the review'))
    }
  }

  function replaceRequest(request: BranchMergeRequest): void {
    setReview((current) => (current ? { ...current, request } : current))
  }

  return {
    plan,
    review,
    loadError,
    reload,
    request: async (note) => {
      const request = await requestCmsBranchMerge(branchId, note)
      replaceRequest(request)
      return request
    },
    withdraw: async () => {
      const request = await withdrawCmsBranchMergeRequest(branchId)
      replaceRequest(request)
      return request
    },
    decline: async (note) => {
      const request = await declineCmsBranchMergeRequest(branchId, note)
      replaceRequest(request)
      return request
    },
    comment: async (entityKey, body) => {
      const comment = await addCmsBranchReviewComment(branchId, { entityKey, body })
      setReview((current) => (current ? { ...current, comments: [...current.comments, comment] } : current))
      return comment
    },
  }
}
