import type { CSSPropertyBag } from '@core/page-tree'

export const radiusCorners = ['nw', 'ne', 'se', 'sw'] as const
export type RadiusCorner = (typeof radiusCorners)[number]
export const radiusProperty = {
  nw: 'borderTopLeftRadius',
  ne: 'borderTopRightRadius',
  se: 'borderBottomRightRadius',
  sw: 'borderBottomLeftRadius',
} as const

/** Ask the CSS engine to expand elliptical and multi-value radius shorthands. */
export function readAuthoredRadii(styles: Record<string, unknown>) {
  const css = document.createElement('div').style
  css.borderRadius = String(styles.borderRadius ?? '')
  return radiusCorners.map((corner) => {
    const key = radiusProperty[corner]
    return String(styles[key] ?? css[key] ?? '')
  })
}

export function editCornerRadii(stored: Record<string, unknown>, value: string | undefined, corner?: RadiusCorner): Partial<CSSPropertyBag> {
  if (!corner) {
    return { borderRadius: undefined, ...Object.fromEntries(radiusCorners.map((c) => [radiusProperty[c], value])) }
  }
  const key = radiusProperty[corner]
  if (!stored.borderRadius) return { [key]: value }
  const values = readAuthoredRadii(stored)
  // A shorthand containing var() may only expand at computed-value time.
  // Keep it in the cascade for the other corners.
  if (values.some((v) => !v)) return { [key]: value }
  return {
    borderRadius: undefined,
    ...Object.fromEntries(radiusCorners.map((c, i) => [radiusProperty[c], c === corner ? value : values[i]])),
  }
}
