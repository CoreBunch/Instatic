/**
 * Every runtime preview build uploads the whole site and re-bundles + renders
 * the page server-side. Rebuilding on each draft change aborted the in-flight
 * build per keystroke or remote collab update (bursts of cancelled requests in
 * production), and blanked the preview each time. Builds wait for the draft to
 * settle, and the previous build stays on screen while the next one runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { SiteDocument } from '@core/page-tree'
import {
  PREVIEW_SITE_SETTLE_MS,
  useRuntimePreviewDocument,
} from '@site/preview/useRuntimePreviewDocument'
import { makePage, makeSite } from '../fixtures'

const originalFetch = globalThis.fetch
let builds = 0

beforeEach(() => {
  builds = 0
  globalThis.fetch = async () => {
    builds += 1
    return new Response(JSON.stringify({
      html: `<html><body>build ${builds}</body></html>`,
      assets: [],
      runtimeAssets: { scripts: [] },
      diagnostics: [],
    }), { status: 200 })
  }
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('useRuntimePreviewDocument', () => {
  it('builds once for a burst of draft changes and keeps the last build meanwhile', async () => {
    const page = makePage({ id: 'home' })
    let site: SiteDocument = makeSite({ name: 'v0', pages: [page] })
    const { result, rerender } = renderHook(
      ({ current }: { current: SiteDocument }) => useRuntimePreviewDocument(current, page, undefined),
      { initialProps: { current: site } },
    )
    await waitFor(() => expect(result.current.html).toContain('build 1'))

    // Five edits in quick succession, each well inside the settle window.
    for (let i = 1; i <= 5; i++) {
      site = makeSite({ name: `v${i}`, pages: [page] })
      act(() => rerender({ current: site }))
      await act(() => sleep(PREVIEW_SITE_SETTLE_MS / 5))
      expect(result.current.html).toContain('build 1')
    }
    expect(builds).toBe(1)

    await waitFor(() => expect(result.current.html).toContain('build 2'), {
      timeout: PREVIEW_SITE_SETTLE_MS * 4,
    })
    expect(builds).toBe(2)
  })
})
