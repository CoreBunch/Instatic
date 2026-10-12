/**
 * base.nav editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 *
 * Renders the same elements, classes, and data attributes as render().
 * Styling comes from the module's `canvasCss` (NAV_CANVAS_CSS).
 *
 * When canvasViewportWidth is at or below the collapseBreakpoint prop, the
 * nav gets `data-instatic-nav-canvas="collapsed"`. The collapsed menu opens
 * while the nav or a node inside it is selected. The toggle button does
 * nothing, because module JS never runs in the canvas.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { cn } from '@ui/cn'
import { htmlAttributesForReact } from '@core/htmlAttributes'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { DockSolidIcon } from 'pixel-art-icons/icons/dock-solid'
import { resolveNavCollapseWidth } from '@modules/base/shared/navCollapse'
import { navToggleIconSvg } from './icons'
import { resolveNavCollapsedStyle, resolveNavColor, type NavStoredProps } from './props'

export const NavEditor: React.FC<ModuleComponentProps<NavStoredProps>> = ({
  props, children, mcClassName, nodeWrapperProps, canvasViewportWidth,
}) => {
  const htmlAttrs = htmlAttributesForReact(props.htmlAttributes)
  const hasChildren = React.Children.count(children) > 0
  const collapseWidth = resolveNavCollapseWidth(props.collapseBreakpoint)
  const iconColor = resolveNavColor(props.toggleIconColor)
  const menuBackground = resolveNavColor(props.menuBackground)
  // Unknown viewport (e.g. agent snapshot rendering) renders the desktop row.
  const isCollapsed = canvasViewportWidth !== undefined && canvasViewportWidth <= collapseWidth

  return (
    <nav
      {...nodeWrapperProps}
      {...htmlAttrs}
      className={cn('instatic-nav', mcClassName)}
      aria-label={props.ariaLabel || undefined}
      data-instatic-nav-canvas={isCollapsed ? 'collapsed' : undefined}
      data-instatic-nav-mode={resolveNavCollapsedStyle(props.collapsedStyle)}
      data-instatic-nav-align={props.menuAlign ?? 'start'}
    >
      <button
        type="button"
        className="instatic-nav__toggle"
        style={iconColor ? { color: iconColor } : undefined}
        tabIndex={-1}
        aria-hidden="true"
      >
        <span
          className="instatic-nav__toggle-icon"
          dangerouslySetInnerHTML={{ __html: navToggleIconSvg(props.toggleIcon) }}
        />
        <span className="instatic-nav__toggle-label">{props.toggleLabel || 'Menu'}</span>
      </button>
      <ul
        className="instatic-nav__menu"
        style={menuBackground ? ({ '--instatic-nav-menu-bg': menuBackground } as React.CSSProperties) : undefined}
      >
        {hasChildren ? children : (
          <li className="instatic-nav__empty">
            <CanvasModulePlaceholder
              variant="inline"
              icon={<DockSolidIcon size={16} color="currentColor" />}
              label="Add Menu Item nodes"
            />
          </li>
        )}
      </ul>
    </nav>
  )
}
