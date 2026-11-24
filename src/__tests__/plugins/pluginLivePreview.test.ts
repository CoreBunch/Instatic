import { afterEach, expect, test } from 'bun:test'
import { hasPluginLivePreview, requestPluginLivePreview, subscribePluginLivePreview } from '@core/plugins/livePreview'
import { pluginRuntime } from '@core/plugins/runtime'

afterEach(() => pluginRuntime.reset())

test('live preview stays active until the last plugin releases it or the host resets', () => {
  const states: boolean[] = []
  const unsubscribe = subscribePluginLivePreview(() => states.push(hasPluginLivePreview()))
  try {
    const releaseFirst = requestPluginLivePreview('acme.first')
    const releaseSecond = requestPluginLivePreview('acme.second')
    pluginRuntime.deactivatePlugin('acme.first')
    releaseFirst()
    expect(hasPluginLivePreview()).toBe(true)
    releaseSecond()
    requestPluginLivePreview('acme.third')
    pluginRuntime.reset()
    expect(states).toEqual([true, false, true, false])
  } finally {
    unsubscribe()
  }
})
