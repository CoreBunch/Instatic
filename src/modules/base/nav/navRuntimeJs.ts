/**
 * Module-JS runtime for base.nav: opens and closes the collapsed menu.
 *
 * A self-contained IIFE with a load guard, bound through document-level
 * event delegation (the RenderOutput.js contract).
 *
 * Handlers find their nav with .closest(), so several base.nav instances on
 * one page stay independent.
 */
export const NAV_RUNTIME_JS = `(() => {
  if (window.__instaticNavRuntimeLoaded) return;
  window.__instaticNavRuntimeLoaded = true;

  var NAV_SELECTOR = '[data-instatic-nav]';
  var TOGGLE_SELECTOR = '[data-instatic-nav-toggle]';

  function setOpen(nav, open) {
    nav.setAttribute('data-instatic-nav-state', open ? 'open' : 'closed');
    var toggle = nav.querySelector(TOGGLE_SELECTOR);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var toggle = target && target.closest ? target.closest(TOGGLE_SELECTOR) : null;
    if (toggle) {
      var nav = toggle.closest(NAV_SELECTOR);
      if (nav) setOpen(nav, nav.getAttribute('data-instatic-nav-state') !== 'open');
      return;
    }
    var link = target && target.closest ? target.closest('a[href]') : null;
    var openNavs = document.querySelectorAll(NAV_SELECTOR + '[data-instatic-nav-state="open"]');
    for (var i = 0; i < openNavs.length; i++) {
      var openNav = openNavs[i];
      if (!openNav.contains(target)) {
        setOpen(openNav, false); // outside click
      } else if (link && openNav.contains(link)) {
        setOpen(openNav, false); // link clicked inside
      }
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var openNavs = document.querySelectorAll(NAV_SELECTOR + '[data-instatic-nav-state="open"]');
    for (var i = 0; i < openNavs.length; i++) {
      var openNav = openNavs[i];
      setOpen(openNav, false);
      var toggle = openNav.querySelector(TOGGLE_SELECTOR);
      if (toggle) toggle.focus();
    }
  });
})();
`
