/**
 * Persists an existing conversation's provider/model selection.
 *
 * A failed PUT is not always a rejection: the response can be lost after the
 * server commits. Re-read the conversation once and classify the result so the
 * store can either accept the requested selection, roll back to a known 4xx
 * state, or fail closed when the commit remains ambiguous.
 */

import {
  getConversation,
  updateConversationProvider,
} from '@admin/ai/api'
import { ApiError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'

const PROVIDER_UPDATE_TIMEOUT_MS = 10_000

export interface ConfirmedProviderSelection {
  conversationId: string
  credentialId: string | null
  modelId: string | null
}

export type ProviderUpdateResult =
  | {
      kind: 'confirmed'
      selection: ConfirmedProviderSelection
    }
  | {
      kind: 'rejected'
      message: string
      selection: ConfirmedProviderSelection | null
    }

function selection(
  conversationId: string,
  credentialId: string | null,
  modelId: string | null,
): ConfirmedProviderSelection {
  return { conversationId, credentialId, modelId }
}

async function updateWithTimeout(
  conversationId: string,
  credentialId: string,
  modelId: string,
): Promise<void> {
  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(),
    PROVIDER_UPDATE_TIMEOUT_MS,
  )
  try {
    await updateConversationProvider(
      conversationId,
      credentialId,
      modelId,
      controller.signal,
    )
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('Model change timed out. Try again.', { cause: err })
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

async function readAfterFailedUpdate(conversationId: string) {
  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(),
    PROVIDER_UPDATE_TIMEOUT_MS,
  )
  try {
    return await getConversation(conversationId, controller.signal)
  } catch (err) {
    console.error('[AgentProviderUpdate] Failed to reconcile provider update:', err)
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function persistConversationProvider(
  conversationId: string,
  credentialId: string,
  modelId: string,
): Promise<ProviderUpdateResult> {
  try {
    await updateWithTimeout(conversationId, credentialId, modelId)
    return {
      kind: 'confirmed',
      selection: selection(conversationId, credentialId, modelId),
    }
  } catch (err) {
    console.error('[AgentProviderUpdate] Failed to update provider:', err)
    let message = getErrorMessage(err, 'Failed to update conversation provider.')

    // Only a handler-originated 4xx is a definite terminal rejection. Network
    // failures, timeouts, and proxy/origin 5xx responses can race a late commit.
    const commitWasAmbiguous = !(
      err instanceof ApiError
      && err.status >= 400
      && err.status < 500
    )
    const authoritative = await readAfterFailedUpdate(conversationId)

    if (
      authoritative?.credentialId === credentialId
      && authoritative.modelId === modelId
    ) {
      // The requested state proves the response was lost after the commit.
      return {
        kind: 'confirmed',
        selection: selection(
          conversationId,
          authoritative.credentialId,
          authoritative.modelId,
        ),
      }
    }

    if (authoritative && !commitWasAmbiguous) {
      // A definite 4xx plus a successful read gives the safe rollback state.
      return {
        kind: 'rejected',
        message,
        selection: selection(
          conversationId,
          authoritative.credentialId,
          authoritative.modelId,
        ),
      }
    }

    message = `${message} The server state could not be confirmed; choose a model again.`
    return { kind: 'rejected', message, selection: null }
  }
}

export function waitForProviderUpdate(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (completed: boolean) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(() => finish(true), () => finish(true))
  })
}
