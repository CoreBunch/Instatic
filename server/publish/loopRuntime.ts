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
 *      returned HTML to the wrapper, then increments the page counter.
 *   4. When `hasMore=false`, removes the button.
 *
 * Endpoint URL is read from `data-instatic-loop-endpoint` on the script tag —
 * defaults to `/_instatic/loop/`. Each loop sends its own pageId (the published
 * page) via a header attached at server-render time below.
 *
 * The runtime is intentionally tiny (< 2 KB minified) to keep the
 * "no JS by default" promise honest — it ships only when at least one
 * infinite-mode loop exists on the page.
 */

function runInstaticLoopRuntime(): void {
  const scriptEl = document.currentScript
  const endpointBase =
    (scriptEl && scriptEl.getAttribute('data-instatic-loop-endpoint')) || '/_instatic/loop/'
  const pagePath = location.pathname

  function attach(loopEl: Element): void {
    let pageNumber = parseInt(loopEl.getAttribute('data-instatic-loop-page') || '1', 10)
    let hasMore = loopEl.getAttribute('data-instatic-loop-has-more') === 'true'
    if (!hasMore) return

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
          pagePath: pagePath,
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
    document.querySelectorAll('[data-instatic-loop][data-instatic-loop-mode="infinite"]').forEach(attach)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
}

export const LOOP_RUNTIME_JS = `(${runInstaticLoopRuntime.toString()})();`
