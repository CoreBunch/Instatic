/**
 * `waitForAgentRenderFrame` must resolve when the frame's readiness marker
 * lands, not on a timer tick. It used to poll every 16ms; in a background tab
 * chained timers are throttled (to one per minute in Chrome), which stalled
 * MCP render snapshots for minutes.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { waitForAgentRenderFrame } from '@site/agent'

function mountFrame(breakpointId: string): HTMLIFrameElement {
  const frame = document.createElement('div')
  frame.dataset.breakpointId = breakpointId
  const iframe = document.createElement('iframe')
  frame.appendChild(iframe)
  document.body.appendChild(frame)
  iframe.contentDocument!.body.dataset.breakpointId = breakpointId
  return iframe
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('waitForAgentRenderFrame', () => {
  it('resolves on the readiness marker even when timers are throttled', async () => {
    // Simulate a background tab: every timer fires at least a second late.
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      realSetTimeout(fn, Math.max(ms ?? 0, 1_000))) as typeof setTimeout
    try {
      const iframe = mountFrame('desktop')
      const startedAt = performance.now()
      const waiting = waitForAgentRenderFrame({ breakpointId: 'desktop', source: 'visible' }, 5_000)
      await Promise.resolve()
      iframe.dataset.instaticCanvasDocumentLoaded = 'true'
      expect(await waiting).not.toBeNull()
      expect(performance.now() - startedAt).toBeLessThan(500)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  it('resolves when the frame mounts after the wait began', async () => {
    const waiting = waitForAgentRenderFrame({ breakpointId: 'tablet', source: 'visible' }, 2_000)
    const iframe = mountFrame('tablet')
    iframe.dataset.instaticCanvasDocumentLoaded = 'true'
    expect(await waiting).not.toBeNull()
  })

  it('returns null at the deadline when the frame never becomes ready', async () => {
    mountFrame('mobile')
    expect(await waitForAgentRenderFrame({ breakpointId: 'mobile', source: 'visible' }, 60)).toBeNull()
  })
})

it('rejects a frame that becomes ready after the deadline', async () => {
  const originalNow = Date.now
  let now = 0
  Date.now = () => now
  try {
    const iframe = mountFrame('desktop')
    const waiting = waitForAgentRenderFrame({ breakpointId: 'desktop', source: 'visible' }, 50)
    now = 100
    iframe.dataset.instaticCanvasDocumentLoaded = 'true'
    expect(await waiting).toBeNull()
  } finally {
    Date.now = originalNow
  }
})
