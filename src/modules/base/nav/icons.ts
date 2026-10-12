/**
 * Inline SVG glyphs for the nav toggle button. Embedded directly because
 * vendored pixel-art-icons cannot be inlined into publisher HTML. Shared by
 * render(), the "Menu icon" picker, and NavEditor.tsx.
 */
function strokeIcon(path: string, strokeWidth = 2): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`
}

export const NAV_TOGGLE_ICONS = [
  { value: 'horizontal-lines', label: 'Horizontal lines', svg: strokeIcon('M4 6h16M4 12h16M4 18h16') },
  { value: 'vertical-lines', label: 'Vertical lines', svg: strokeIcon('M6 4v16M12 4v16M18 4v16') },
  { value: 'chevron', label: 'Chevron', svg: strokeIcon('M6 9l6 6 6-6') },
  // Zero-length segments with round caps draw as dots.
  { value: 'meatball', label: 'Meatball', svg: strokeIcon('M5 12h.01M12 12h.01M19 12h.01', 3) },
] as const

export type NavToggleIcon = (typeof NAV_TOGGLE_ICONS)[number]['value']

/** Unknown values (a node stored before the prop existed) fall back to the first glyph. */
export function navToggleIconSvg(value: unknown): string {
  return (NAV_TOGGLE_ICONS.find((icon) => icon.value === value) ?? NAV_TOGGLE_ICONS[0]).svg
}
