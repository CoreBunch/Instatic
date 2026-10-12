/**
 * Module-JS runtime for base.nav-item: the submenu toggle.
 *
 * A self-contained IIFE with a load guard, bound through document-level
 * event delegation (the RenderOutput.js contract).
 *
 * The toggle is the caret button beside a linked label, or the label itself
 * when the item is not a link. Collapsed, it drives the accordion. On
 * desktop it pins a dropdown open, where hover and focus also open it
 * through CSS.
 *
 * Escape or a click outside an open item closes it. A click in a nested item
 * is inside its ancestors, so they stay open.
 *
 * Independent of base.nav's runtime: a toggle click is inside the <nav>, so
 * base.nav's outside-click handler ignores it.
 */
export const NAV_ITEM_RUNTIME_JS = `(() => {
  if (window.__instaticNavItemRuntimeLoaded) return;
  window.__instaticNavItemRuntimeLoaded = true;

  var TOGGLE_SELECTOR = '[data-instatic-nav-item-toggle]';
  var ITEM_SELECTOR = '.instatic-nav-item';
  var OPEN_SELECTOR = ITEM_SELECTOR + '[data-instatic-nav-item-state="open"]';

  function setOpen(item, open) {
    item.setAttribute('data-instatic-nav-item-state', open ? 'open' : 'closed');
    var toggle = item.querySelector(':scope > ' + TOGGLE_SELECTOR);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var toggle = target && target.closest ? target.closest(TOGGLE_SELECTOR) : null;
    var item = toggle ? toggle.closest(ITEM_SELECTOR) : null;
    var openItems = document.querySelectorAll(OPEN_SELECTOR);
    for (var i = 0; i < openItems.length; i++) {
      if (openItems[i] !== item && !openItems[i].contains(target)) setOpen(openItems[i], false);
    }
    if (!item) return;
    event.preventDefault();
    setOpen(item, item.getAttribute('data-instatic-nav-item-state') !== 'open');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var openItems = document.querySelectorAll(OPEN_SELECTOR);
    for (var i = 0; i < openItems.length; i++) setOpen(openItems[i], false);
  });
})();
`
