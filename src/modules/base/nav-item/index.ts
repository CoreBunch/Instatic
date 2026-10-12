/**
 * base.nav-item: a nestable navigation entry.
 *
 * Renders `<li><a>label</a></li>`. An item with children is a submenu: it
 * also renders a toggle button and a `<ul>` around the children. Items nest
 * to any depth.
 *
 * With the "Link" prop off the label is not an <a>. On an item with a submenu
 * the label is the toggle button.
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { Value } from '@core/utils/typeboxHelpers'
import { Bulletlist2SharpIcon } from 'pixel-art-icons/icons/bulletlist-2-sharp'
import { safeUrl } from '@modules/base/utils/escape'
import { ANCHOR_TARGET_OPTIONS, anchorRel } from '@modules/base/shared/anchorTarget'
import {
  htmlAttributesControl,
} from '@modules/base/shared/htmlAttributes'
import { htmlAttributesAttr } from '@core/publisher'
import { navItemHasSubmenu, navItemIsLink } from './content'
import { NAV_ITEM_CARET_SVG } from './icons'
import { NAV_ITEM_CANVAS_CSS, NAV_ITEM_CSS } from './navItemCss'
import { NAV_ITEM_RUNTIME_JS } from './navItemRuntimeJs'
import { NavItemEditor } from './NavItemEditor'
import { NavItemPropsSchema, type NavItemStoredProps } from './props'

export const NavItemModule: ModuleDefinition<NavItemStoredProps> = {
  id: 'base.nav-item',
  name: 'Menu Item',
  description: 'A navigation link. Nest more Menu Items inside to build a submenu.',
  category: 'Navigation',
  version: '1.0.0',
  icon: Bulletlist2SharpIcon,
  trusted: true,
  canHaveChildren: true,

  schema: {
    label: { type: 'text', label: 'Label' },
    isLink: {
      type: 'toggle',
      label: 'Enable link',
      description: 'Turn off to make this item a static label. On an item with a submenu, clicking the label then opens the submenu instead of following the link.',
    },
    // `notEq: false` keeps Link and Target visible on a node stored before `isLink` existed.
    href: { type: 'url', label: 'Link', condition: { field: 'isLink', notEq: false } },
    target: {
      type: 'select',
      label: 'Target',
      options: [...ANCHOR_TARGET_OPTIONS],
      condition: { field: 'isLink', notEq: false },
    },
    htmlAttributes: htmlAttributesControl(),
  },

  propsSchema: NavItemPropsSchema,

  defaults: Value.Create(NavItemPropsSchema),

  component: NavItemEditor,

  canvasCss: NAV_ITEM_CANVAS_CSS,

  htmlTag: 'li',

  render: (props, renderedChildren) => {
    const attrs = htmlAttributesAttr(props.htmlAttributes)
    const label = String(props.label ?? '')
    const hasSubmenu = navItemHasSubmenu(renderedChildren.length)
    const caret = `<span class="instatic-nav-item__toggle-icon" aria-hidden="true">${NAV_ITEM_CARET_SVG}</span>`
    const toggleAttrs = 'data-instatic-nav-item-toggle aria-expanded="false"'

    let labelHtml: string
    if (navItemIsLink(props.isLink)) {
      const rel = anchorRel(props.target)
      const relAttr = rel ? ` rel="${rel}"` : ''
      labelHtml = `<a class="instatic-nav-item__link" href="${safeUrl(props.href)}" target="${String(props.target)}"${relAttr}>${label}</a>`
      if (hasSubmenu) {
        labelHtml += `<button type="button" class="instatic-nav-item__toggle" ${toggleAttrs} aria-label="Toggle submenu">${caret}</button>`
      }
    } else if (hasSubmenu) {
      // Not a link: the label itself is the submenu toggle.
      labelHtml = `<button type="button" class="instatic-nav-item__link" ${toggleAttrs}>${label}${caret}</button>`
    } else {
      labelHtml = `<span class="instatic-nav-item__link">${label}</span>`
    }

    const html = hasSubmenu
      ? `<li class="instatic-nav-item" data-instatic-nav-item-state="closed"${attrs}>${labelHtml}`
        + `<ul class="instatic-nav-item__submenu">${renderedChildren.join('')}</ul></li>`
      : `<li class="instatic-nav-item"${attrs}>${labelHtml}</li>`

    return { html, css: NAV_ITEM_CSS, js: NAV_ITEM_RUNTIME_JS }
  },
}

registry.registerOrReplace(NavItemModule)
