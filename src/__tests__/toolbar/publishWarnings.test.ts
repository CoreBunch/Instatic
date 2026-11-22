/**
 * The toast for a publish that left lists empty: short whatever the count,
 * silent when the server sent no warnings at all, and still honest when the
 * code that words the warnings cannot be loaded.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { LOOP_SOURCES_STALE_EVENT } from '@site/canvas/loopSourceEvents'
import { showPublishWarnings } from '@site/toolbar/publishWarnings'
import { reportPublishWarnings } from '@site/toolbar/reportPublishWarnings'

let toasts: readonly Toast[] = []
let refreshes = 0
let unsubscribe = () => {}
const countRefresh = () => { refreshes += 1 }

beforeEach(() => {
  __resetToastBusForTests()
  toasts = []
  refreshes = 0
  unsubscribe = subscribeToasts((current) => { toasts = current })
  window.addEventListener(LOOP_SOURCES_STALE_EVENT, countRefresh)
})

afterEach(() => {
  unsubscribe()
  __resetToastBusForTests()
  window.removeEventListener(LOOP_SOURCES_STALE_EVENT, countRefresh)
})

const warning = (sourceId: string, pages: string[], pageCount = pages.length) =>
  ({ kind: 'loop-source-unavailable' as const, sourceId, pages, pageCount })

describe('showPublishWarnings', () => {
  it('says nothing for a publish without warnings, or from a server that sends none', () => {
    showPublishWarnings({ publishedPages: 3, warnings: [], warningsTotal: 0 })
    showPublishWarnings({ publishedPages: 3 })
    expect(toasts).toEqual([])
    expect(refreshes).toBe(0)
  })

  it('names the source and its page, and refetches the sources', () => {
    showPublishWarnings({ publishedPages: 3, warnings: [warning('acme.shop.offers', ['Shop'])], warningsTotal: 1 })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ kind: 'warning', title: 'Published, but a loop source is not available' })
    expect(toasts[0]!.body).toContain('“acme.shop.offers” (on Shop)')
    expect(refreshes).toBe(1)
  })

  it('counts sources, not pages, and stays short for many', () => {
    const listed = [
      warning('acme.shop.offers', ['P0', 'P1', 'P2'], 200),
      warning('acme.blog.posts', ['Blog']),
      ...Array.from({ length: 8 }, (_, i) => warning(`acme.gone.${i}`, ['X'])),
    ]
    showPublishWarnings({ publishedPages: 900, warnings: listed, warningsTotal: 14 })
    expect(toasts[0]!.title).toBe('Published, but 14 loop sources are not available')
    expect(toasts[0]!.body).toContain('“acme.shop.offers” (on P0 and 199 other pages)')
    expect(toasts[0]!.body).toContain('“acme.blog.posts” (on Blog)')
    expect(toasts[0]!.body).not.toContain('acme.gone.0')
    expect(toasts[0]!.body).toContain('and 12 more')
    expect(String(toasts[0]!.body).length).toBeLessThan(300)
  })
})

describe('reportPublishWarnings', () => {
  const result = { publishedPages: 3, warnings: [warning('acme.shop.offers', ['Shop'])], warningsTotal: 1 }

  it('does not load anything for a publish without warnings', async () => {
    let loads = 0
    const load = async () => { loads += 1; return { showPublishWarnings } }
    await reportPublishWarnings({ publishedPages: 3, warnings: [] }, load)
    await reportPublishWarnings({ publishedPages: 3 }, load)
    expect(loads).toBe(0)
    expect(toasts).toEqual([])
  })

  it('shows the warnings once their code has loaded', async () => {
    await reportPublishWarnings(result, async () => ({ showPublishWarnings }))
    expect(toasts.map((toast) => toast.title)).toEqual(['Published, but a loop source is not available'])
  })

  it('still tells the author when the code that words the warnings cannot be loaded', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Resolves, never rejects: a failed load is not an unhandled rejection.
      await reportPublishWarnings(result, async () => { throw new Error('chunk gone') })
      expect(toasts).toHaveLength(1)
      expect(toasts[0]).toMatchObject({ kind: 'warning', title: 'Published, with warnings' })
      expect(toasts[0]!.body).toContain('published')
      expect(String(logged.mock.calls[0]![0])).toContain('[publish]')
    } finally {
      logged.mockRestore()
    }
  })
})
