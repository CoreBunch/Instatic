import { describe, expect, spyOn, test } from 'bun:test'
import { resolveModelCapabilities } from '../../../server/ai/drivers/modelCapabilities'
import { listProviderModels } from '../../../server/ai/drivers/modelList'
import type {
  AiProvider,
  AiProviderCapabilities,
  AiResolvedCredential,
} from '../../../server/ai/drivers/types'

const TEXT_ONLY: AiProviderCapabilities = {
  toolCalling: true,
  visionInput: false,
  toolResultImages: false,
  promptCache: false,
  streaming: true,
}

const VISION: AiProviderCapabilities = {
  toolCalling: true,
  visionInput: true,
  toolResultImages: false,
  promptCache: false,
  streaming: true,
}

const credentials: AiResolvedCredential = {
  id: 'credential-1',
  providerId: 'openrouter',
  authMode: 'apiKey',
  apiKey: 'secret',
  baseUrl: null,
}

function provider(
  fallback: AiProviderCapabilities,
  resolveCapabilities?: (
    credentials: AiResolvedCredential,
    modelId: string,
  ) => Promise<AiProviderCapabilities>,
): AiProvider {
  return {
    id: 'openrouter',
    label: 'Test provider',
    supportedAuthModes: ['apiKey'],
    capabilities: () => fallback,
    ...(resolveCapabilities ? { resolveCapabilities } : {}),
    async listModels() {
      throw new Error('full catalogue should not be queried for capability resolution')
    },
    async *stream() {
      yield { type: 'done' }
    },
  }
}

describe('resolveModelCapabilities', () => {
  test('uses an authoritative vision-capable static default without a catalogue request', async () => {
    const driver = provider(VISION)

    expect(await resolveModelCapabilities(driver, credentials, 'vision-model')).toEqual(VISION)
  })

  test('uses a provider-owned selected-model capability lookup', async () => {
    const driver = provider(TEXT_ONLY, async () => VISION)

    expect(await resolveModelCapabilities(driver, credentials, 'vision-model')).toEqual(VISION)
  })

  test('fails closed to the static capability when live discovery fails', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const driver = provider(VISION, async () => {
        throw new Error('catalogue unavailable')
      })

      expect(await resolveModelCapabilities(driver, credentials, 'vision-model')).toEqual(TEXT_ONLY)
      expect(errorLog).toHaveBeenCalledTimes(1)
    } finally {
      errorLog.mockRestore()
    }
  })

  test('de-duplicates and caches concurrent selected-model lookups', async () => {
    let calls = 0
    const driver = provider(TEXT_ONLY, async () => {
      calls += 1
      await Promise.resolve()
      return VISION
    })

    const [first, second] = await Promise.all([
      resolveModelCapabilities(driver, credentials, 'vision-model'),
      resolveModelCapabilities(driver, credentials, 'vision-model'),
    ])
    const cached = await resolveModelCapabilities(driver, credentials, 'vision-model')

    expect(first).toEqual(VISION)
    expect(second).toEqual(VISION)
    expect(cached).toEqual(VISION)
    expect(calls).toBe(1)
  })

  test('fails closed for every waiter when a de-duplicated lookup rejects', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    try {
      const driver = provider(VISION, async () => {
        calls += 1
        await Promise.resolve()
        throw new Error('catalogue unavailable')
      })

      const results = await Promise.all([
        resolveModelCapabilities(driver, credentials, 'vision-model'),
        resolveModelCapabilities(driver, credentials, 'vision-model'),
      ])

      expect(results).toEqual([TEXT_ONLY, TEXT_ONLY])
      expect(calls).toBe(1)
      expect(errorLog).toHaveBeenCalledTimes(1)
    } finally {
      errorLog.mockRestore()
    }
  })

  test('invalidates a cached result when credential auth material changes', async () => {
    let calls = 0
    const driver = provider(TEXT_ONLY, async () => {
      calls += 1
      return calls === 1 ? VISION : TEXT_ONLY
    })

    const first = await resolveModelCapabilities(driver, credentials, 'vision-model')
    const rotated = await resolveModelCapabilities(driver, {
      ...credentials,
      apiKey: 'rotated-secret',
    }, 'vision-model')

    expect(first).toEqual(VISION)
    expect(rotated).toEqual(TEXT_ONLY)
    expect(calls).toBe(2)
  })
})

describe('listProviderModels', () => {
  test('releases the caller on abort even if a driver forgets to settle', async () => {
    let providerSignal: AbortSignal | undefined
    const driver: AiProvider = {
      ...provider(TEXT_ONLY),
      listModels(_credentials, signal) {
        providerSignal = signal
        return new Promise(() => {})
      },
    }
    const controller = new AbortController()
    const models = listProviderModels(driver, credentials, controller.signal)

    controller.abort()

    await expect(models).rejects.toHaveProperty('name', 'AbortError')
    expect(providerSignal?.aborted).toBe(true)
  })
})
