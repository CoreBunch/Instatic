/**
 * CSS for base.nav-item.
 *
 * NAV_ITEM_CSS: static rules, emitted once per module type. A submenu opens
 * on hover, on keyboard focus, or when its toggle is open.
 * navItemCollapseCss(width): the collapsed accordion, where only the toggle
 * opens a submenu. Emitted by base.nav, which owns the width.
 * NAV_ITEM_CANVAS_CSS: the module's `canvasCss`, the same rules with the
 * canvas selectors. See shared/navCollapse.ts.
 */
import { NAV_CANVAS_COLLAPSED, NAV_CANVAS_OPEN } from '@modules/base/shared/navCollapse'

const NAV_ITEM_OPEN = '[data-instatic-nav-item-state="open"]'

/** Left padding of a link in the collapsed layout, by submenu depth. */
export const NAV_ITEM_COLLAPSED_INDENTS = [28, 44, 60]

function navItemStaticCss(open: string): string {
  return `
.instatic-nav-item {
  position: relative;
  display: flex;
  align-items: center;
}
.instatic-nav-item__link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  color: inherit;
  text-decoration: none;
}
button.instatic-nav-item__link {
  background: none;
  border: 0;
  font: inherit;
  cursor: pointer;
}
.instatic-nav-item__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 0;
  padding: 6px 8px;
  margin-left: -4px;
  cursor: pointer;
  color: inherit;
}
.instatic-nav-item__toggle-icon {
  display: inline-flex;
  width: 14px;
  height: 14px;
  transition: transform 0.15s ease;
}
.instatic-nav-item__submenu {
  list-style: none;
  margin: 0;
  padding: 0;
}
.instatic-nav-item > .instatic-nav-item__submenu {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 180px;
  display: none;
  flex-direction: column;
  background-color: var(--instatic-nav-menu-bg, Canvas);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  z-index: 20;
}
.instatic-nav-item:hover > .instatic-nav-item__submenu,
.instatic-nav-item:focus-within > .instatic-nav-item__submenu,
.instatic-nav-item${open} > .instatic-nav-item__submenu {
  display: flex;
}
.instatic-nav-item .instatic-nav-item > .instatic-nav-item__submenu {
  top: 0;
  left: 100%;
}
`
}

/** The accordion layout for items inside the nav matched by `scope`. An item matching `open` shows its submenu. */
function navItemCollapseRules(scope: string, open: string): string {
  // Nested levels indent their links, not the list, so each row and its
  // background still span the full width of the menu.
  const indents = NAV_ITEM_COLLAPSED_INDENTS.map((indent, depth) => `
  ${scope}${' .instatic-nav-item__submenu'.repeat(depth + 1)} .instatic-nav-item__link {
    padding-left: ${indent}px;
  }`).join('')

  return `
  ${scope} .instatic-nav-item {
    flex-wrap: wrap;
    width: 100%;
  }
  ${scope} .instatic-nav-item > .instatic-nav-item__submenu {
    position: static;
    display: none;
    flex-basis: 100%;
    min-width: 0;
    box-shadow: none;
    background-color: transparent;
  }${indents}
  ${scope} .instatic-nav-item:hover > .instatic-nav-item__submenu,
  ${scope} .instatic-nav-item:focus-within > .instatic-nav-item__submenu {
    display: none;
  }
  ${scope} .instatic-nav-item${open} > .instatic-nav-item__submenu {
    display: flex;
  }
  ${scope} .instatic-nav-item${open} > * > .instatic-nav-item__toggle-icon {
    transform: rotate(180deg);
  }`
}

export function navItemCollapseCss(width: number): string {
  return `
@media (max-width: ${width}px) {${navItemCollapseRules(`.instatic-nav[data-instatic-nav-collapse="${width}"]`, NAV_ITEM_OPEN)}
}`
}

export const NAV_ITEM_CSS = navItemStaticCss(NAV_ITEM_OPEN)

export const NAV_ITEM_CANVAS_CSS = `${navItemStaticCss(NAV_CANVAS_OPEN)}${navItemCollapseRules(NAV_CANVAS_COLLAPSED, NAV_CANVAS_OPEN)}
`
