/**
 * Browser runtime for `base.loop` infinite loading.
 *
 * Self-contained ES module — no dependencies, no framework. The publisher
 * injects a `<script type="module" src="/_instatic/assets/loop-runtime.js">` tag
 * into pages that contain at least one `pagination='infinite'` loop.
 *
 * On load, the runtime:
 *   1. Finds every `[data-instatic-loop][data-instatic-loop-mode="infinite"]` element.
 *   2. If `data-instatic-loop-has-more="true"`, attaches a "Load more" button.
 *   3. On click, fetches `<endpoint>/<loopId>?page=N` and appends the
 *      validated HTML to the wrapper, then accepts the returned page counter.
 *   4. When `hasMore=false`, removes the button.
 *
 * Endpoint URL is read from `data-instatic-loop-endpoint` on the script tag —
 * defaults to `/_instatic/loop/`. Each loop sends its originating path/query
 * and published version; the endpoint resolves that same public route.
 *
 * The runtime has no visitor dependencies and ships only when at least one
 * infinite-mode loop exists on the page.
 */

import { TypeCompiler } from '@sinclair/typebox/compiler'
import { LoopPageResponseSchema, type LoopPageResponse } from '@core/loops-schema'

function runInstaticLoopRuntime(isLoopPageResponse: (value: unknown) => value is LoopPageResponse): void {
  // Located by attribute rather than `document.currentScript`, which the HTML
  // spec leaves null inside a module script — and the publisher injects this
  // as `type="module"`. Reading currentScript therefore always fell through to
  // the default below, so the endpoint attribute was never honoured. The
  // runtime is deferred by virtue of being a module, so the tag is parsed and
  // queryable by the time this runs.
  const scriptEl = document.querySelector('script[data-instatic-loop-endpoint]')
  const endpointBase =
    (scriptEl && scriptEl.getAttribute('data-instatic-loop-endpoint')) || '/_instatic/loop/'
  const pagePath = location.pathname + location.search

  function attach(loopEl: Element): void {
    let pageNumber = parseInt(loopEl.getAttribute('data-instatic-loop-page') || '1', 10)
    let hasMore = loopEl.getAttribute('data-instatic-loop-has-more') === 'true'
    if (!hasMore) return

    const loopId = loopEl.getAttribute('data-instatic-loop')
    if (!loopId) return
    const loadMoreLabel = loopEl.getAttribute('data-instatic-loop-load-more-label')
    const loadingLabel = loopEl.getAttribute('data-instatic-loop-loading-label')
    const retryLabel = loopEl.getAttribute('data-instatic-loop-retry-label')
    const version = loopEl.getAttribute('data-instatic-loop-version')
    if (loadMoreLabel === null || loadingLabel === null || retryLabel === null || version === null) return

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'instatic-loop-load-more'
    button.textContent = loadMoreLabel
    button.setAttribute('data-instatic-loop-load-more', loopId)

    let busy = false
    button.addEventListener('click', async () => {
      if (busy || !hasMore) return
      busy = true
      button.disabled = true
      button.textContent = loadingLabel
      loopEl.setAttribute('aria-busy', 'true')
      try {
        const params = new URLSearchParams({
          page: String(pageNumber + 1),
          pagePath: pagePath,
          v: version,
        })
        const res = await fetch(endpointBase + encodeURIComponent(loopId) + '?' + params.toString(), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!res.ok) throw new Error('Loop fetch failed: ' + res.status)
        const body: unknown = await res.json()
        if (!isLoopPageResponse(body) || body.pageNumber !== pageNumber + 1) throw new Error('Invalid loop response')
        if (body.html.length > 0) {
          // Insert before the button so the button stays at the end.
          button.insertAdjacentHTML('beforebegin', body.html)
        }
        pageNumber = body.pageNumber
        hasMore = body.hasMore
        loopEl.setAttribute('data-instatic-loop-page', String(pageNumber))
        loopEl.setAttribute('data-instatic-loop-has-more', hasMore ? 'true' : 'false')
        if (!hasMore) {
          button.remove()
        }
        button.textContent = loadMoreLabel
      } catch (err) {
        console.error('[instatic-loop]', err)
        button.textContent = retryLabel
      } finally {
        busy = false
        button.disabled = false
        loopEl.setAttribute('aria-busy', 'false')
      }
    })

    loopEl.appendChild(button)
  }

  function init(): void {
    document.querySelectorAll('[data-instatic-loop][data-instatic-loop-mode="infinite"]').forEach(attach)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
}

// Compile the shared TypeBox wire schema into a dependency-free visitor asset.
const responseCheckCode = TypeCompiler.Compile(LoopPageResponseSchema).Code()
export const LOOP_RUNTIME_JS = `(${runInstaticLoopRuntime.toString()})((() => {${responseCheckCode}})());`
