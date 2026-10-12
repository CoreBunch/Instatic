/**
 * CSS for base.nav.
 *
 * NAV_CSS: static rules, emitted once per module type.
 * navCollapseCss(width): the collapsed layout, emitted through `instanceCss`.
 * NAV_CANVAS_CSS: the module's `canvasCss`, the same rules with the canvas
 * selectors. See shared/navCollapse.ts.
 *
 * Menu panels read their background from `--instatic-nav-menu-bg`, which
 * render() sets from the "Menu background" prop. Unset, they use the `Canvas`
 * system colour.
 */
import { NAV_CANVAS_COLLAPSED, NAV_CANVAS_OPEN } from '@modules/base/shared/navCollapse'

const NAV_OPEN = '[data-instatic-nav-state="open"]'

/** The collapsed layout for the nav matched by `scope`, opened when it also matches `open`. */
function navCollapseRules(scope: string, open: string): string {
  return `
  ${scope} > .instatic-nav__toggle {
    display: inline-flex;
  }
  ${scope}[data-instatic-nav-align="center"] {
    justify-content: center;
  }
  ${scope}[data-instatic-nav-align="end"] {
    justify-content: flex-end;
  }
  ${scope} > .instatic-nav__menu {
    display: none;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    width: 100%;
  }
  ${scope}${open} > .instatic-nav__menu {
    display: flex;
  }
  ${scope}[data-instatic-nav-mode="dropdown"] > .instatic-nav__menu {
    position: absolute;
    top: 100%;
    left: 0;
    width: auto;
    min-width: max(100%, 200px);
    background-color: var(--instatic-nav-menu-bg, Canvas);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    z-index: 30;
  }
  ${scope}[data-instatic-nav-mode="dropdown"][data-instatic-nav-align="end"] > .instatic-nav__menu {
    left: auto;
    right: 0;
  }
  ${scope}[data-instatic-nav-mode="overlay"] > .instatic-nav__menu {
    position: fixed;
    inset: 0;
    width: auto;
    box-sizing: border-box;
    padding: 64px 24px 24px;
    overflow-y: auto;
    background-color: var(--instatic-nav-menu-bg, Canvas);
    z-index: 1000;
  }
  ${scope}[data-instatic-nav-mode="overlay"]${open} > .instatic-nav__toggle {
    position: relative;
    z-index: 1001;
  }`
}

export function navCollapseCss(width: number): string {
  const scope = `.instatic-nav[data-instatic-nav-collapse="${width}"]`
  return `
@media (max-width: ${width}px) {${navCollapseRules(scope, NAV_OPEN)}
  html:has(${scope}[data-instatic-nav-mode="overlay"]${NAV_OPEN}) {
    overflow: hidden;
  }
}`
}

export const NAV_CSS = `
.instatic-nav {
  position: relative;
  display: flex;
  align-items: center;
}
.instatic-nav__toggle {
  display: none;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: none;
  border: 0;
  padding: 8px;
  cursor: pointer;
  color: inherit;
}
.instatic-nav__toggle-icon {
  display: inline-flex;
  width: 20px;
  height: 20px;
}
.instatic-nav__toggle-label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.instatic-nav__menu {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.instatic-nav[data-instatic-nav-align="center"] > .instatic-nav__menu {
  justify-content: center;
}
.instatic-nav[data-instatic-nav-align="end"] > .instatic-nav__menu {
  justify-content: flex-end;
}
`

// A canvas frame is as tall as the whole page, so the published `inset: 0`
// overlay would cover every other node. Cap it at one viewport height.
export const NAV_CANVAS_CSS = `${NAV_CSS}${navCollapseRules(NAV_CANVAS_COLLAPSED, NAV_CANVAS_OPEN)}
  ${NAV_CANVAS_COLLAPSED}[data-instatic-nav-mode="overlay"] > .instatic-nav__menu {
    inset: 0 0 auto;
    height: 100vh;
  }
`
