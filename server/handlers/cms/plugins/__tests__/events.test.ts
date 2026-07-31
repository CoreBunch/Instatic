import { describe, expect, it } from 'bun:test'
import { __pluginEventSubscriberCountForTesting } from '../../../../plugins/eventBroadcaster'
import { handlePluginEventsStream } from '../events'

const decoder = new TextDecoder()

async function connectPluginEventStream(): Promise<{
  requestController: AbortController
  reader: ReadableStreamDefaultReader<Uint8Array>
}> {
  const requestController = new AbortController()
  const response = handlePluginEventsStream(new Request(
    'http://localhost/admin/api/cms/plugins/events',
    { signal: requestController.signal },
  ))
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(decoder.decode(first.value)).toContain('event: ping')
  return { requestController, reader }
}

describe('plugin event stream', () => {
  it('cleans up when the response consumer cancels without aborting the request', async () => {
    const { requestController, reader } = await connectPluginEventStream()

    try {
      expect(__pluginEventSubscriberCountForTesting()).toBe(1)
      await reader.cancel()
      expect(requestController.signal.aborted).toBe(false)
      expect(__pluginEventSubscriberCountForTesting()).toBe(0)
    } finally {
      await reader.cancel().catch(() => {})
      requestController.abort()
    }
  })

  it('leaves no subscribers across repeated connect and cancel cycles', async () => {
    for (let index = 0; index < 100; index += 1) {
      const { requestController, reader } = await connectPluginEventStream()
      await reader.cancel()
      requestController.abort()
      expect(__pluginEventSubscriberCountForTesting()).toBe(0)
    }
  })
})
