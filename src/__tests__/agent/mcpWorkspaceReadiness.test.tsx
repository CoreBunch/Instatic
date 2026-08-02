import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useMcpWorkspaceBridge } from '@admin/ai/useMcpWorkspaceBridge'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

afterEach(() => {
  cleanup()
})

describe('MCP workspace bridge readiness', () => {
  it('does not register a Site bridge before the editor store is hydrated', async () => {
    const realFetch = globalThis.fetch
    let bridgeRequests = 0
    globalThis.fetch = (async () => {
      bridgeRequests += 1
      return new Response(null, { status: 401 })
    }) as typeof fetch

    const dispatch = async () => ({ ok: true as const })
    try {
      const view = renderHook(
        ({ enabled }) => {
          useMcpWorkspaceBridge('site', dispatch, undefined, enabled)
        },
        { initialProps: { enabled: false } },
      )
      await Promise.resolve()

      expect(bridgeRequests).toBe(0)

      view.rerender({ enabled: true })
      await waitFor(() => {
        expect(bridgeRequests).toBe(1)
      })
    } finally {
      cleanup()
      globalThis.fetch = realFetch
    }
  })

  it('gates SitePage bridge registration on the hydrated editor store', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/admin/pages/site/SitePage.tsx'),
      'utf8',
    )

    expect(source).toContain(
      'const siteHydrated = useEditorStore((state) => state.site !== null)',
    )
    expect(source).toContain(
      "useMcpWorkspaceBridge('site', executeAgentTool, undefined, siteHydrated)",
    )
  })
})
