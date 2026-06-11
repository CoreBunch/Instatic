/**
 * Provider-normalised "context used" — the total input tokens a model held in
 * context for one turn, computed consistently across providers' differing usage
 * accounting so the composer's context meter compares like-for-like.
 *
 *   - Anthropic reports `input_tokens` EXCLUDING the cache buckets, so the true
 *     total is prompt + cacheRead + cacheCreation.
 *   - OpenAI / OpenRouter / Ollama report `input_tokens` as the full input (any
 *     cached tokens are already a subset), so prompt alone is the total.
 *
 * Two callers share this: the chat handler injects the value onto the wire
 * `usage` event for the live meter, and the persister writes it to the
 * conversation row so the meter survives a reload.
 */

import type { AiProviderId } from './runtime/types'

interface ContextUsageTokens {
  promptTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export function normalizeContextTokens(
  providerId: AiProviderId,
  usage: ContextUsageTokens,
): number {
  if (providerId === 'anthropic') {
    return usage.promptTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
  }
  return usage.promptTokens
}
