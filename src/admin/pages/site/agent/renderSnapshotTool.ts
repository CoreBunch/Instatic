import {
  aiToolError,
  aiToolOk,
  RenderSnapshotInputSchema,
  type AiToolImage,
  type AiToolOutput,
} from '@core/ai'
import type { Static } from '@core/utils/typeboxHelpers'
import { captureAgentRenderSnapshot, SnapshotNodeNotFoundError } from './renderEvidence'
import type { AgentRenderSnapshotPayload } from './types'

type RenderSnapshotToolInput = Static<typeof RenderSnapshotInputSchema> & {
  captureScreenshot?: boolean
}

export async function runRenderSnapshot(
  input: RenderSnapshotToolInput,
): Promise<AiToolOutput> {
  // Default true so a direct (non-server) invocation still works; the AI loop
  // always sets this explicitly from the model's vision capability.
  const captureScreenshot = input.captureScreenshot ?? true
  let snapshot: AgentRenderSnapshotPayload | null
  try {
    snapshot = await captureAgentRenderSnapshot({
      breakpointId: input.breakpointId,
      nodeId: input.nodeId,
      captureScreenshot,
    })
  } catch (err) {
    if (err instanceof SnapshotNodeNotFoundError) return aiToolError(err.message)
    throw err
  }
  if (!snapshot) {
    return aiToolError('No canvas frame found for the requested breakpoint.')
  }

  // The PNG travels through the dedicated image channel (a native image block on
  // vision providers) — NEVER inlined into `data` as base64 JSON text, which is
  // what blew a single snapshot past a million tokens. `data` keeps the layout
  // report plus a compact screenshot descriptor (status + dimensions only).
  const { screenshot, ...rest } = snapshot
  const images: AiToolImage[] = []
  if (screenshot.status === 'ok' && screenshot.data && screenshot.mimeType) {
    images.push({ mimeType: screenshot.mimeType, data: screenshot.data })
  }
  const screenshotMeta = {
    status: screenshot.status,
    ...(screenshot.width != null ? { width: screenshot.width } : {}),
    ...(screenshot.height != null ? { height: screenshot.height } : {}),
    ...(screenshot.error ? { error: screenshot.error } : {}),
  }

  return aiToolOk({ ...rest, screenshot: screenshotMeta }, images)
}
