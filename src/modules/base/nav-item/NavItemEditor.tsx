/**
 * base.nav-item editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 *
 * Renders the same elements and classes as render(). Styling comes from the
 * module's `canvasCss` (NAV_ITEM_CANVAS_CSS). A submenu opens while this item
 * or a node inside it is selected. The toggle buttons do nothing, because
 * module JS never runs in the canvas.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { cn } from '@ui/cn'
import { anchorRel } from '@modules/base/shared/anchorTarget'
import { htmlAttributesForReact } from '@core/htmlAttributes'
import { navItemHasSubmenu, navItemIsLink } from './content'
import { NAV_ITEM_CARET_SVG } from './icons'
import type { NavItemStoredProps } from './props'

const caret = (
  <span className="instatic-nav-item__toggle-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: NAV_ITEM_CARET_SVG }} />
)

export const NavItemEditor: React.FC<ModuleComponentProps<NavItemStoredProps>> = ({
  props, children, mcClassName, nodeWrapperProps,
}) => {
  const childCount = Array.isArray(children) ? children.length : children != null ? 1 : 0
  const hasSubmenu = navItemHasSubmenu(childCount)
  const isLink = navItemIsLink(props.isLink)
  const htmlAttrs = htmlAttributesForReact(props.htmlAttributes)
  const label = props.label || 'Menu item'

  return (
    <li {...nodeWrapperProps} {...htmlAttrs} className={cn('instatic-nav-item', mcClassName)}>
      {isLink ? (
        <a
          className="instatic-nav-item__link"
          href={props.href || '#'}
          target={props.target}
          rel={anchorRel(props.target) ?? undefined}
        >
          {label}
        </a>
      ) : hasSubmenu ? (
        <button type="button" className="instatic-nav-item__link" tabIndex={-1}>{label}{caret}</button>
      ) : (
        <span className="instatic-nav-item__link">{label}</span>
      )}
      {hasSubmenu ? (
        <>
          {isLink ? (
            <button type="button" className="instatic-nav-item__toggle" tabIndex={-1} aria-hidden="true">{caret}</button>
          ) : null}
          <ul className="instatic-nav-item__submenu">
            {children}
          </ul>
        </>
      ) : null}
    </li>
  )
}
