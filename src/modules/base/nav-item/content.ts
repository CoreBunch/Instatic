/**
 * Element decisions for base.nav-item, shared by render() and the editor
 * component.
 *
 * Kept in a non-component `.ts` file so the editor component can import it
 * without breaking React Fast Refresh.
 */

/**
 * A nav-item renders its submenu toggle and submenu list only when it has
 * children. A childless item is a plain <li><a>.
 */
export function navItemHasSubmenu(childCount: number): boolean {
  return childCount > 0
}

/**
 * Whether the label is a link. When it is not, the label of an item with a
 * submenu is the submenu toggle itself. A node stored before the prop existed
 * is a link.
 */
export function navItemIsLink(value: unknown): boolean {
  return value !== false
}
