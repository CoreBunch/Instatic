/**
 * base.nav: collapsible navigation wrapper.
 *
 * Renders a <nav> with a menu toggle button and a <ul> of children. Nested
 * base.nav-item nodes are the menu, so the page tree is the menu structure.
 * Below the configured width it collapses into a dropdown or full-screen
 * overlay, driven by its own CSS and module-JS runtime. Works anywhere on the
 * page, not only in a header.
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { Value } from '@core/utils/typeboxHelpers'
import { DockSolidIcon } from 'pixel-art-icons/icons/dock-solid'
import {
  htmlAttributesControl,
} from '@modules/base/shared/htmlAttributes'
import { htmlAttributesAttr } from '@core/publisher'
import { NAV_COLLAPSE_PRESETS, resolveNavCollapseWidth } from '@modules/base/shared/navCollapse'
import { navItemCollapseCss } from '@modules/base/nav-item/navItemCss'
import { NAV_TOGGLE_ICONS, navToggleIconSvg } from './icons'
import { NAV_CANVAS_CSS, NAV_CSS, navCollapseCss } from './navCss'
import { NAV_RUNTIME_JS } from './navRuntimeJs'
import { NavEditor } from './NavEditor'
import {
  NAV_COLLAPSED_STYLES,
  NAV_MENU_ALIGNMENTS,
  NavPropsSchema,
  resolveNavCollapsedStyle,
  resolveNavColor,
  type NavStoredProps,
} from './props'

export const NavModule: ModuleDefinition<NavStoredProps> = {
  id: 'base.nav',
  name: 'Header Navigation',
  description: 'A collapsible nav bar. Nest Menu Item nodes inside to build the menu.',
  category: 'Navigation',
  version: '1.0.0',
  icon: DockSolidIcon,
  trusted: true,
  canHaveChildren: true,

  schema: {
    ariaLabel: {
      type: 'text',
      label: 'Accessible name',
      description: 'Read by screen readers to tell this landmark apart from other nav regions on the page (e.g. a footer nav).',
    },
    toggleLabel: {
      type: 'text',
      label: 'Menu button label',
      description: 'Screen-reader-only text for the collapsed menu button.',
    },
    collapseBreakpoint: {
      type: 'number',
      label: 'Collapse below',
      description: 'Viewport width at which the menu button takes over from the normal row. Pick a preset or type any width; 0 never collapses.',
      min: 0,
      unit: 'px',
      presets: NAV_COLLAPSE_PRESETS,
    },
    collapsedStyle: {
      type: 'select',
      label: 'Collapsed menu',
      description: 'Dropdown opens a panel under the nav. Overlay covers the whole screen.',
      options: NAV_COLLAPSED_STYLES.map((value) => ({
        value,
        label: value === 'dropdown' ? 'Dropdown' : 'Overlay',
      })),
    },
    menuBackground: {
      type: 'color',
      label: 'Menu background',
      description: "Background of the collapsed menu and of submenus. Leave empty to use the browser's default page background.",
    },
    toggleIcon: {
      type: 'select',
      label: 'Menu icon',
      options: NAV_TOGGLE_ICONS.map(({ value, label, svg }) => ({ value, label, iconSvg: svg })),
    },
    toggleIconColor: {
      type: 'color',
      label: 'Menu icon color',
      description: 'Leave empty to use the surrounding text color.',
    },
    menuAlign: {
      type: 'select',
      label: 'Menu alignment',
      description: 'Where the menu items sit inside the nav bar. When collapsed, where the menu button sits.',
      layout: 'inline',
      options: NAV_MENU_ALIGNMENTS.map((value) => ({
        value,
        label: value === 'start' ? 'Start' : value === 'center' ? 'Center' : 'End',
      })),
    },
    htmlAttributes: htmlAttributesControl(),
  },

  propsSchema: NavPropsSchema,

  defaults: Value.Create(NavPropsSchema),

  component: NavEditor,

  canvasCss: NAV_CANVAS_CSS,

  htmlTag: 'nav',

  render: (props, renderedChildren) => {
    const attrs = htmlAttributesAttr(props.htmlAttributes)
    const ariaLabel = String(props.ariaLabel ?? '')
    const toggleLabel = String(props.toggleLabel ?? '')
    const ariaLabelAttr = ariaLabel ? ` aria-label="${ariaLabel}"` : ''
    const collapseBreakpoint = resolveNavCollapseWidth(props.collapseBreakpoint)
    const menuAlign = String(props.menuAlign ?? 'start')
    const collapsedStyle = resolveNavCollapsedStyle(props.collapsedStyle)
    const menuBackground = resolveNavColor(props.menuBackground)
    const iconColor = resolveNavColor(props.toggleIconColor)
    const toggleStyleAttr = iconColor ? ` style="color:${iconColor}"` : ''
    // On the list, not the <nav>: submenus inside it inherit the property.
    const menuStyleAttr = menuBackground ? ` style="--instatic-nav-menu-bg:${menuBackground}"` : ''

    const html =
      `<nav class="instatic-nav" data-instatic-nav data-instatic-nav-state="closed" data-instatic-nav-collapse="${collapseBreakpoint}" data-instatic-nav-mode="${collapsedStyle}" data-instatic-nav-align="${menuAlign}"${attrs}${ariaLabelAttr}>`
      + `<button type="button" class="instatic-nav__toggle" data-instatic-nav-toggle aria-expanded="false"${toggleStyleAttr}>`
      +   `<span class="instatic-nav__toggle-icon" aria-hidden="true">${navToggleIconSvg(props.toggleIcon)}</span>`
      +   `<span class="instatic-nav__toggle-label">${toggleLabel}</span>`
      + `</button>`
      + `<ul class="instatic-nav__menu"${menuStyleAttr}>${renderedChildren.join('')}</ul>`
      + `</nav>`

    // Collapse rules at this instance's width, for the nav and its Menu Items.
    const instanceCss = navCollapseCss(collapseBreakpoint) + navItemCollapseCss(collapseBreakpoint)

    return { html, css: NAV_CSS, instanceCss, js: NAV_RUNTIME_JS }
  },
}

registry.registerOrReplace(NavModule)
