import type { CSSPropertyBag } from '@core/page-tree'

export const EXTRA_LAYOUT_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'alignSelf', 'justifySelf', 'flex', 'gridColumn', 'gridRow',
  'rowGap', 'columnGap',
]
