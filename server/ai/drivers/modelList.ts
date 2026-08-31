import type { AiProvider, AiProviderModel, AiResolvedCredential } from './types'

const MODEL_LIST_TIMEOUT_MS = 10_000

/**
 * Resolve a provider catalogue with both caller cancellation and a server-side
 * deadline. `AbortSignal.any` composes the two; the race on top releases the
 * HTTP handler even if a driver forgets to honour the signal (fetch-based
 * drivers do honour it, and stop their upstream request).
 */
export async function listProviderModels(
  driver: AiProvider,
  credentials: AiResolvedCredential,
  parentSignal?: AbortSignal,
): Promise<AiProviderModel[]> {
  const deadline = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS)
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline

  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(
      deadline.aborted
        ? new Error('Model catalogue request timed out.')
        : signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
    )
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })

  return Promise.race([driver.listModels(credentials, signal), aborted])
}
