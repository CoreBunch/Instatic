import { Type, type Static } from '@core/utils/typeboxHelpers'
import { HtmlAttributesPropSchemaOptions } from '@modules/base/shared/htmlAttributes'
import { NAV_COLLAPSE_DEFAULT } from '@modules/base/shared/navCollapse'
import { NAV_TOGGLE_ICONS } from './icons'

/** Viewport width in px at or below which the nav collapses. */
export const NavCollapseBreakpointSchema = Type.Number({ default: NAV_COLLAPSE_DEFAULT, minimum: 0 })

export const NAV_MENU_ALIGNMENTS = ['start', 'center', 'end'] as const
export const NavMenuAlignSchema = Type.Union(
  NAV_MENU_ALIGNMENTS.map((align) => Type.Literal(align)),
  { default: 'start' },
)

/**
 * How the collapsed menu opens: `dropdown` is a panel anchored under the nav,
 * `overlay` covers the whole viewport.
 */
export const NAV_COLLAPSED_STYLES = ['dropdown', 'overlay'] as const
export type NavCollapsedStyle = (typeof NAV_COLLAPSED_STYLES)[number]
export const NavCollapsedStyleSchema = Type.Union(
  NAV_COLLAPSED_STYLES.map((style) => Type.Literal(style)),
  { default: 'dropdown' },
)

export const NavToggleIconSchema = Type.Union(
  NAV_TOGGLE_ICONS.map((icon) => Type.Literal(icon.value)),
  { default: 'horizontal-lines' },
)

export const NavPropsSchema = Type.Object({
  ariaLabel: Type.String({ default: 'Primary navigation' }),
  toggleLabel: Type.String({ default: 'Menu' }),
  collapseBreakpoint: NavCollapseBreakpointSchema,
  collapsedStyle: NavCollapsedStyleSchema,
  /** Background of the collapsed menu and of submenus. Empty uses the `Canvas` system colour. */
  menuBackground: Type.String({ default: '' }),
  toggleIcon: NavToggleIconSchema,
  /** Empty inherits the surrounding text colour. */
  toggleIconColor: Type.String({ default: '' }),
  menuAlign: NavMenuAlignSchema,
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

export type NavStoredProps = Static<typeof NavPropsSchema>

/** Unknown values (a node stored before the prop existed) fall back to `dropdown`. */
export function resolveNavCollapsedStyle(value: unknown): NavCollapsedStyle {
  return value === 'overlay' ? 'overlay' : 'dropdown'
}

/**
 * An authored colour as a value safe to place in a `style` attribute.
 * Returns null when it is empty or is not a plain colour (hex, rgb()/hsl(),
 * var(--token), or a keyword), so a stored value cannot add declarations.
 */
export function resolveNavColor(value: unknown): string | null {
  const color = String(value ?? '').trim()
  return /^[\w#(),.%/\s-]+$/.test(color) ? color : null
}
