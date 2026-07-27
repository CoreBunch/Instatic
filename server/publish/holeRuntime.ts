/**
 * Browser runtime for Layer C server-island ("hole") lazy loading.
 *
 * Self-contained ES module — no dependencies, no TypeScript. The publisher
 * injects a `<script type="module" src="/_instatic/hole-runtime.js" defer>` tag
 * into pages that contain at least one `<instatic-hole>` placeholder.
 *
 * On load, the runtime uses `IntersectionObserver` with a 200 px root margin
 * to begin fetching each hole's rendered fragment just before it enters the
 * viewport. Holes already in view on initial paint begin fetching immediately.
 *
 * IMPORTANT: the `<instatic-hole>` element itself is `display:contents` (so it adds
 * no wrapper box), which means it has NO layout box for IntersectionObserver
 * to observe — observing it directly never fires. We therefore observe the
 * hole's baked placeholder CHILD (which DOES have a box) and swap the whole
 * `<instatic-hole>` when it intersects. A hole with no placeholder child has nothing
 * to lazily reveal, so it is fetched eagerly on load.
 *
 * The fragment fetch URL is
 * `/_instatic/hole/<nodeId>?v=<publishVersion>&u=<originating-page-url>`. The
 * version parameter lets the hole endpoint detect stale placeholders after a
 * re-publish and return a lightweight sentinel instead of cached stale HTML.
 * The `u` parameter carries the visitor's actual page path + query string so
 * the endpoint can rebuild the route frame (`route.query.*`) and key the cache
 * per query. Cookies ride along automatically (same-origin fetch) and are read
 * by the endpoint only for `perVisitor` holes.
 *
 * When the fetch resolves, `el.outerHTML = html` swaps the placeholder with
 * the server-rendered fragment in-place. No morphdom / idiomorph dependency.
 * A fetch failure is silently swallowed — the author's skeleton content in the
 * placeholder continues to show as a meaningful fallback.
 */

export function runInstaticHoleRuntime(): void {
  function instaticFetchHole(el: HTMLElement): void {
    const id = el.dataset.instaticHole || '';
    const version = el.dataset.instaticVersion || '';
    const u = location.pathname + location.search;
    fetch('/_instatic/hole/' + encodeURIComponent(id) + '?v=' + encodeURIComponent(version) + '&u=' + encodeURIComponent(u))
      .then(function(r) { return r.text(); })
      .then(function(html) { el.outerHTML = html; })
      .catch(function() {});
  }
  const io = new IntersectionObserver(function(entries) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const hole = e.target.closest('instatic-hole[data-instatic-hole]') as HTMLElement | null;
      if (hole) instaticFetchHole(hole);
    }
  }, { rootMargin: '200px 0px' });
  const holes = document.querySelectorAll('instatic-hole[data-instatic-hole]');
  for (let i = 0; i < holes.length; i++) {
    const el = holes[i] as HTMLElement;
    // <instatic-hole> is display:contents (no box) — observe its placeholder child,
    // which has a box. Holes without a placeholder are fetched eagerly.
    const box = el.firstElementChild;
    if (box) { io.observe(box); } else { instaticFetchHole(el); }
  }

  // Auth-gated containers — mirror the hole logic but fetch the real subtree
  // from /_instatic/gate/<id>. The endpoint renders the subtree only for
  // authorised visitors and returns the baked fallback for everyone else, so
  // unauthorised visitors keep seeing the placeholder content.
  function instaticFetchGate(el: HTMLElement): void {
    const id = el.dataset.instaticGate || '';
    const version = el.dataset.instaticVersion || '';
    const u = location.pathname + location.search;
    fetch('/_instatic/gate/' + encodeURIComponent(id) + '?v=' + encodeURIComponent(version) + '&u=' + encodeURIComponent(u))
      .then(function(r) { return r.text(); })
      .then(function(html) { el.outerHTML = html; })
      .catch(function() {});
  }
  const gated = document.querySelectorAll('instatic-gated[data-instatic-gate]');
  // Only construct the gate IntersectionObserver when there are gated elements
  // to observe — avoids creating a second observer (and clobbering any
  // test/caller that captures the last-constructed IntersectionObserver) on
  // pages that only use holes.
  if (gated.length > 0) {
    const gateIo = new IntersectionObserver(function(entries) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e.isIntersecting) continue;
        gateIo.unobserve(e.target);
        const gate = e.target.closest('instatic-gated[data-instatic-gate]') as HTMLElement | null;
        if (gate) instaticFetchGate(gate);
      }
    }, { rootMargin: '200px 0px' });
    for (let i = 0; i < gated.length; i++) {
      const el = gated[i] as HTMLElement;
      // <instatic-gated> is display:contents (no box) — observe its placeholder
      // child, which has a box. Gates without a placeholder are fetched eagerly.
      const box = el.firstElementChild;
      if (box) { gateIo.observe(box); } else { instaticFetchGate(el); }
    }
  }
}

export const HOLE_RUNTIME_JS = `(${runInstaticHoleRuntime.toString()})();`
