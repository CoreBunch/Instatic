/**
 * Driver registry — resolves a provider id to its driver implementation.
 *
 * Drivers are the ONLY place provider SDKs are imported. The runtime,
 * handlers, tools, and UI never reach into Anthropic / OpenAI / Ollama
 * SDKs directly — they go through the `AiProvider` interface here.
 */

import type { AiProvider } from './types'
import type { AiProviderId } from '../runtime/types'
import { anthropicDriver } from './anthropic'
import { openaiDriver } from './openai'
import { ollamaDriver } from './ollama'
import { openrouterDriver } from './openrouter'

const DRIVERS: Record<AiProviderId, AiProvider> = {
  anthropic: anthropicDriver,
  openai: openaiDriver,
  ollama: ollamaDriver,
  openrouter: openrouterDriver,
}

/** Returns the driver for a provider id, or throws if unknown. */
export function resolveDriver(providerId: AiProviderId): AiProvider {
  const driver = DRIVERS[providerId]
  if (!driver) {
    throw new Error(`[ai/drivers] Unknown provider id: ${providerId}`)
  }
  return driver
}


