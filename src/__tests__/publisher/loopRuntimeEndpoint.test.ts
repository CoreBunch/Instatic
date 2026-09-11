/**
 * Loop runtime endpoint resolution (#395).
 *
 * The publisher injects the runtime as `<script type="module">`, and the HTML
 * spec leaves `document.currentScript` null inside a module script. The
 * runtime read the endpoint off `currentScript`, so the
 * `data-instatic-loop-endpoint` attribute was never honoured and every fetch
 * fell through to the hardcoded default.
 *
 * No user-visible breakage today, because both producers happen to pass the
 * same string as the fallback. These tests pin the plumbing so the first
 * change that sets a different endpoint (subpath mount, CDN prefix) does not
 * silently keep hitting `/_instatic/loop/`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { LOOP_RUNTIME_JS } from '../../../server/publish/loopRuntime'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

/**
 * Render a page carrying one infinite loop plus the runtime script tag, run
 * the runtime, click "Load more", and report the URL it fetched.
 */
async function fetchedUrlFor(endpointAttr: string | null): Promise<string> {
  document.head.innerHTML = endpointAttr === null
    ? '<script type="module" src="/_instatic/assets/loop-runtime.js"></script>'
    : `<script type="module" src="/_instatic/assets/loop-runtime.js" data-instatic-loop-endpoint="${endpointAttr}"></script>`

  document.body.innerHTML = `
    <div data-instatic-loop="loop-1"
         data-instatic-loop-mode="infinite"
         data-instatic-loop-page="1"
         data-instatic-loop-has-more="true"></div>
  `

  let requested = ''
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = typeof input === 'string' ? input : String(input)
    // The shape the runtime actually consumes: it parses JSON and reads
    // `html` / `hasMore`. Returning an empty body made it throw mid-handler.
    return new Response(JSON.stringify({ html: '', hasMore: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  // The runtime is shipped as a self-invoking source string.
  new Function(LOOP_RUNTIME_JS)()

  const button = document.querySelector('[data-instatic-loop-load-more]') as HTMLButtonElement | null
  expect(button).not.toBeNull()
  button!.click()
  // Let the click handler's async work settle.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return requested
}

describe('loop runtime endpoint', () => {
  it('honours data-instatic-loop-endpoint from the script tag', async () => {
    const url = await fetchedUrlFor('/cdn-prefix/loop/')
    expect(url.startsWith('/cdn-prefix/loop/')).toBe(true)
  })

  it('falls back to the default when the attribute is absent', async () => {
    const url = await fetchedUrlFor(null)
    expect(url.startsWith('/_instatic/loop/')).toBe(true)
  })

  it('does not depend on document.currentScript, which is null in a module', () => {
    // The regression guard: currentScript is spec-null inside `type="module"`,
    // so reading it can only ever yield the fallback.
    expect(LOOP_RUNTIME_JS).not.toContain('currentScript')
  })
})
