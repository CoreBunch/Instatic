import { describe, expect, it } from 'bun:test'
import { ApiError } from '@core/http'
import { buildCmsRuntimePreview, resolveCmsRuntimeDependencies } from '@core/persistence'

describe('CMS runtime client', () => {
  it('posts dependency manifests to the runtime resolve endpoint', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const dependencyLock = {
      version: 1,
      packages: {},
      updatedAt: 123,
    }
    const packageImportmap = {
      imports: { 'canvas-confetti': '/_instatic/runtime/cache/abc/canvas-confetti/dist/confetti.module.mjs' },
      lockHash: 'abc',
    }

    const result = await resolveCmsRuntimeDependencies(
      { dependencies: { 'canvas-confetti': '^1.9.3' }, devDependencies: {} },
      async (input, init) => {
        calls.push({ input, init })
        return new Response(
          JSON.stringify({ dependencyLock, packageImportmap }),
          { status: 200 },
        )
      },
    )

    expect(result.dependencyLock).toEqual(dependencyLock)
    expect(result.packageImportmap).toEqual(packageImportmap)
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/runtime/dependencies/resolve',
      init: { method: 'POST', credentials: 'include' },
    })
    expect(calls[0].init?.body).toBe(JSON.stringify({
      packageJson: { dependencies: { 'canvas-confetti': '^1.9.3' }, devDependencies: {} },
    }))
  })

  it('returns only the lock when the server skips importmap build', async () => {
    const dependencyLock = { version: 1, packages: {}, updatedAt: 0 }
    const result = await resolveCmsRuntimeDependencies(
      { dependencies: {}, devDependencies: {} },
      async () => new Response(JSON.stringify({ dependencyLock }), { status: 200 }),
    )
    expect(result.dependencyLock).toEqual(dependencyLock)
    expect(result.packageImportmap).toBeUndefined()
  })

  // F4: dependencyLock is now validated against SiteDependencyLockSchema rather
  // than cast `as SiteDependencyLock`. A type-drifted lock must be rejected at
  // readEnvelope, not silently cast into a broken value.
  it('rejects a dependency lock whose shape fails the schema', async () => {
    await expect(
      resolveCmsRuntimeDependencies(
        { dependencies: {}, devDependencies: {} },
        // `version` must be the literal 1; a server returning 2 is type-drift.
        async () =>
          new Response(
            JSON.stringify({ dependencyLock: { version: 2, packages: {}, updatedAt: 0 } }),
            { status: 200 },
          ),
      ),
    ).rejects.toThrow()
  })

  it('throws ApiError with .status when the resolve endpoint rejects', async () => {
    let caught: unknown
    try {
      await resolveCmsRuntimeDependencies(
        { dependencies: {}, devDependencies: {} },
        async () => new Response(JSON.stringify({ error: 'install_failed' }), { status: 500 }),
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).status).toBe(500)
    expect((caught as ApiError).message).toBe('install_failed')
  })

  // F4: runtimeAssets + diagnostics are now validated against the
  // @core/site-runtime schemas instead of cast. A malformed runtimeAssets is
  // rejected at the boundary.
  it('rejects a runtime preview whose runtimeAssets shape fails the schema', async () => {
    await expect(
      buildCmsRuntimePreview(
        { site: { id: 's' }, pageId: 'p' },
        {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                html: '<x>',
                assets: [],
                // scripts must be an array of script-asset objects, not a string.
                runtimeAssets: { scripts: 'nope' },
                diagnostics: [],
              }),
              { status: 200 },
            ),
        },
      ),
    ).rejects.toThrow()
  })

  it('posts site preview requests to the runtime preview endpoint', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const controller = new AbortController()
    const result = await buildCmsRuntimePreview(
      {
        site: { id: 'site_1' },
        pageId: 'page_1',
        breakpointId: 'mobile',
        templateContext: { entryStack: [] },
      },
      {
        signal: controller.signal,
        fetchImpl: async (input, init) => {
          calls.push({ input, init })
          return new Response(JSON.stringify({
            html: '<!DOCTYPE html>',
            assets: [],
            runtimeAssets: { scripts: [] },
            diagnostics: [],
          }), { status: 200 })
        },
      },
    )

    expect(result.html).toContain('<!DOCTYPE html>')
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/runtime/preview',
      init: { method: 'POST', credentials: 'include' },
    })
    expect(calls[0].init?.signal).toBe(controller.signal)
    expect(calls[0].init?.body).toBe(JSON.stringify({
      site: { id: 'site_1' },
      pageId: 'page_1',
      breakpointId: 'mobile',
      templateContext: { entryStack: [] },
    }))
  })
})
