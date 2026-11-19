/**
 * The toast for a publish that left lists empty: short whatever the count,
 * and silent when the server sent no warnings at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { LOOP_SOURCES_STALE_EVENT } from '@site/canvas/loopSourceEvents'
import { showPublishWarnings } from '@site/toolbar/publishWarnings'

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

const warning = (page: string) => ({ kind: 'loop-source-unavailable' as const, page, sourceId: 'acme.shop.offers' })

describe('showPublishWarnings', () => {
  it('says nothing for a publish without warnings, or from a server that sends none', () => {
    showPublishWarnings({ publishedPages: 3, warnings: [], warningsTotal: 0 })
    showPublishWarnings({ publishedPages: 3 })
    expect(toasts).toEqual([])
    expect(refreshes).toBe(0)
  })

  it('names the page and the source of one empty list and refetches the sources', () => {
    showPublishWarnings({ publishedPages: 3, warnings: [warning('Shop')], warningsTotal: 1 })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ kind: 'warning', title: 'Published, with an empty list' })
    expect(toasts[0]!.body).toContain('“acme.shop.offers” on the page Shop')
    expect(refreshes).toBe(1)
  })

  it('stays short for many: the count, two names, and how many more', () => {
    const listed = Array.from({ length: 10 }, (_, i) => warning(`Page ${i}`))
    showPublishWarnings({ publishedPages: 900, warnings: listed, warningsTotal: 412 })
    expect(toasts[0]!.title).toBe('Published, with 412 empty lists')
    expect(toasts[0]!.body).toContain('Page 0')
    expect(toasts[0]!.body).toContain('Page 1')
    expect(toasts[0]!.body).not.toContain('Page 2')
    expect(toasts[0]!.body).toContain('and 410 more')
    expect(String(toasts[0]!.body).length).toBeLessThan(300)
  })
})
