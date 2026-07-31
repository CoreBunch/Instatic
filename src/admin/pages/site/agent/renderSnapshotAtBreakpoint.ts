/**
 * Exact-breakpoint orchestration for `site_render_snapshot`.
 *
 * Every capture renders once through CanvasRoot's transient AgentSnapshotFrame
 * at the configured viewport width. That deterministic path can wait for async
 * preview data/media and never depends on whether a visible frame happens to
 * be mounted, collapsed, clamped, or in Live mode. The transient slot is
 * serialized because providers may issue tool calls in parallel while
 * CanvasRoot intentionally owns only one such frame.
 */

import { nanoid } from 'nanoid'
import {
  aiToolError,
  RenderSnapshotInputSchema,
  type AiToolOutput,
} from '@core/ai'
import type { Static } from '@core/utils/typeboxHelpers'
import type { EditorStore } from '@site/store/types'
import { getAgentStoreApi } from './storeRef'
import { runRenderSnapshot } from './renderSnapshotTool'
import { waitForAgentRenderFrame } from './renderEvidence'

type RenderSnapshotAtBreakpointInput = Static<typeof RenderSnapshotInputSchema> & {
  breakpointId: string
  captureScreenshot?: boolean
}

const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

// The tail never rejects, so one failed capture cannot poison later requests.
let transientSnapshotCaptureTail: Promise<void> = Promise.resolve()

async function withTransientSnapshotFrame<T>(capture: () => Promise<T>): Promise<T> {
  const precedingCapture = transientSnapshotCaptureTail
  let releaseCapture!: () => void
  transientSnapshotCaptureTail = new Promise<void>((resolve) => {
    releaseCapture = resolve
  })

  await precedingCapture
  try {
    return await capture()
  } finally {
    releaseCapture()
  }
}

export async function runRenderSnapshotAtBreakpoint(
  input: RenderSnapshotAtBreakpointInput,
): Promise<AiToolOutput> {
  const store = getStoreState()
  const breakpoint = store.site?.breakpoints.find(
    (candidate) => candidate.id === input.breakpointId,
  )
  if (!breakpoint) return aiToolError(`Breakpoint not found: ${input.breakpointId}`)

  return withTransientSnapshotFrame(async () => {
    const requestId = nanoid()
    getStoreState().setAgentSnapshotCaptureRequest({
      requestId,
      breakpointId: input.breakpointId,
    })
    try {
      const transientFrame = await waitForAgentRenderFrame({
        breakpointId: input.breakpointId,
        source: 'transient',
        requestId,
      })
      if (!transientFrame) {
        return aiToolError(
          `Canvas frame for breakpoint ${input.breakpointId} did not become ready.`,
        )
      }
      return await runRenderSnapshot(input, transientFrame)
    } finally {
      const latest = getStoreState()
      if (latest.agentSnapshotCaptureRequest?.requestId === requestId) {
        latest.setAgentSnapshotCaptureRequest(null)
      }
    }
  })
}
