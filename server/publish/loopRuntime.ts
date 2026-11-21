/**
 * Browser runtime for `base.loop` infinite loading.
 *
 * Self-contained ES module — no dependencies, no framework. The publisher
 * injects a `<script type="module" src="/_instatic/assets/loop-runtime.js?v=<contentHash>">` tag
 * into pages that contain at least one `pagination='infinite'` loop.
 *
 * On load, the runtime:
 *   1. Finds every `[data-instatic-loop][data-instatic-loop-mode="infinite"]` element.
 *   2. If `data-instatic-loop-has-more="true"`, attaches a "Load more" button.
 *   3. On click, fetches `<endpoint>/<loopId>?page=N` and appends the
 *      returned HTML to the wrapper, then increments the page counter.
 *   4. When `hasMore=false`, removes the button.
 *
 * Endpoint URL is read from `data-instatic-loop-endpoint` on the script tag —
 * defaults to `/_instatic/loop/`. Each request carries the originating path and query in pagePath.
 *
 * The runtime is intentionally tiny (< 2 KB minified) to keep the
 * "no JS by default" promise honest — it ships only when at least one
 * infinite-mode loop exists on the page.
 */
import { assetContentVersion } from './assetVersion'

function runInstaticLoopRuntime(): void {
  // Located by attribute rather than `document.currentScript`, which the HTML
  // spec leaves null inside a module script — and the publisher injects this
  // as `type="module"`. Reading currentScript therefore always fell through to
  // the default below, so the endpoint attribute was never honoured. The
  // runtime is deferred by virtue of being a module, so the tag is parsed and
  // queryable by the time this runs.
  const scriptEl = document.querySelector('script[data-instatic-loop-endpoint]')
  const endpointBase =
    (scriptEl && scriptEl.getAttribute('data-instatic-loop-endpoint')) || '/_instatic/loop/'
  const selector = '[data-instatic-loop][data-instatic-loop-mode="infinite"]'
  const attached = new WeakSet<Element>()

  function attach(loopEl: Element): void {
    let pageNumber = parseInt(loopEl.getAttribute('data-instatic-loop-page') || '1', 10)
    let hasMore = loopEl.getAttribute('data-instatic-loop-has-more') === 'true'
    if (!hasMore || attached.has(loopEl)) return
    attached.add(loopEl)

    const loopId = loopEl.getAttribute('data-instatic-loop')
    if (!loopId) return

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'instatic-loop-load-more'
    button.textContent = 'Load more'
    button.setAttribute('data-instatic-loop-load-more', loopId)

    let busy = false
    button.addEventListener('click', async () => {
      if (busy || !hasMore) return
      busy = true
      button.disabled = true
      const prev = button.textContent
      button.textContent = 'Loading…'
      try {
        const params = new URLSearchParams({
          page: String(pageNumber + 1),
          pagePath: location.pathname + location.search,
        })
        const res = await fetch(endpointBase + encodeURIComponent(loopId) + '?' + params.toString(), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!res.ok) throw new Error('Loop fetch failed: ' + res.status)
        const body = await res.json()
        if (typeof body.html === 'string' && body.html.length > 0) {
          // Insert before the button so the button stays at the end.
          button.insertAdjacentHTML('beforebegin', body.html)
        }
        pageNumber += 1
        hasMore = body.hasMore === true
        loopEl.setAttribute('data-instatic-loop-page', String(pageNumber))
        loopEl.setAttribute('data-instatic-loop-has-more', hasMore ? 'true' : 'false')
        if (!hasMore) {
          button.remove()
        }
      } catch (err) {
        console.error('[instatic-loop]', err)
        button.textContent = 'Try again'
      } finally {
        busy = false
        button.disabled = false
        if (button.textContent === 'Loading…') button.textContent = prev
      }
    })

    loopEl.appendChild(button)
  }

  function init(): void {
    document.querySelectorAll(selector).forEach(attach)
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          if (node.matches(selector)) attach(node)
          node.querySelectorAll(selector).forEach(attach)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
}

export const LOOP_RUNTIME_JS = `(${runInstaticLoopRuntime.toString()})();`

/**
 * Content hash of the runtime, stamped as `?v=` on its script tag so a CMS
 * upgrade that changes the runtime changes the URL browsers have cached.
 */
export const LOOP_RUNTIME_VERSION = assetContentVersion(LOOP_RUNTIME_JS)
