/** Post a browser-executed AI/MCP tool result back to its server bridge. */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import type { AiToolOutput } from '@core/ai'

const TOOL_RESULT_PATH = '/admin/api/ai/tool-result'
const ToolResultAckSchema = Type.Object({ ok: Type.Boolean() })

export async function postToolResult(
  bridgeId: string,
  requestId: string,
  result: AiToolOutput,
  signal: AbortSignal | null,
  snapshot?: unknown,
): Promise<void> {
  try {
    await apiRequest(TOOL_RESULT_PATH, {
      method: 'POST',
      body: {
        bridgeId,
        requestId,
        result,
        ...(snapshot !== undefined ? { snapshot } : {}),
      },
      signal,
      schema: ToolResultAckSchema,
      fallbackMessage: 'Tool-result POST failed.',
    })
  } catch (err) {
    // Once the caller has torn down the bridge, the POST outcome is irrelevant.
    if (signal?.aborted) return
    throw err
  }
}
