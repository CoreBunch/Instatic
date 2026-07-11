import type { AiProvider, AiProviderModel, AiResolvedCredential } from './types'

const MODEL_LIST_TIMEOUT_MS = 10_000

/**
 * Resolve a provider catalogue with both caller cancellation and a server-side
 * deadline. The race releases the HTTP handler even if a future driver forgets
 * to honour the signal; current fetch-based drivers also stop their upstream
 * request when the composed controller aborts.
 */
export async function listProviderModels(
  driver: AiProvider,
  credentials: AiResolvedCredential,
  parentSignal?: AbortSignal,
): Promise<AiProviderModel[]> {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })

  const timeoutId = setTimeout(() => {
    controller.abort(new Error('Model catalogue request timed out.'))
  }, MODEL_LIST_TIMEOUT_MS)
  let rejectAborted!: (reason?: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
  const rejectAbort = () => rejectAborted(
    controller.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
  )
  if (controller.signal.aborted) rejectAbort()
  else controller.signal.addEventListener('abort', rejectAbort, { once: true })

  try {
    return await Promise.race([
      driver.listModels(credentials, controller.signal),
      aborted,
    ])
  } finally {
    clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', abortFromParent)
    controller.signal.removeEventListener('abort', rejectAbort)
  }
}
