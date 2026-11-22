export const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const
export type Side = (typeof SIDES)[number]
export type BorderField = 'Width' | 'Style' | 'Color'

export function borderKey(side: Side, field: BorderField) {
  return `border${side}${field}` as const
}
