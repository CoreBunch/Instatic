/**
 * Icon pack registry — GENERATED. Do not edit by hand.
 * Run `bun run icons:manifest` to regenerate.
 *
 * Only this file is imported eagerly. Each pack's icons arrive through its
 * own `load()` dynamic import, so opening the picker costs one small list
 * and browsing one family costs exactly that family.
 */
export interface IconPack {
  id: string
  label: string
  count: number
  load: () => Promise<ReadonlyArray<readonly [name: string, svg: string]>>
}

export const ICON_PACKS: readonly IconPack[] = [
  { id: 'pixel', label: 'Pixel Art', count: 134,
    load: () => import('./pixel').then((m) => m.ICONS) },
  { id: 'fi', label: 'Feather', count: 287,
    load: () => import('./fi').then((m) => m.ICONS) },
  { id: 'fa6', label: 'Font Awesome 6', count: 2058,
    load: () => import('./fa6').then((m) => m.ICONS) },
  { id: 'md', label: 'Material Design', count: 4341,
    load: () => import('./md').then((m) => m.ICONS) },
  { id: 'bs', label: 'Bootstrap', count: 2754,
    load: () => import('./bs').then((m) => m.ICONS) },
  { id: 'io5', label: 'Ionicons 5', count: 1332,
    load: () => import('./io5').then((m) => m.ICONS) },
  { id: 'ri', label: 'Remix', count: 3229,
    load: () => import('./ri').then((m) => m.ICONS) },
  { id: 'tb', label: 'Tabler', count: 6146,
    load: () => import('./tb').then((m) => m.ICONS) },
  { id: 'si', label: 'Simple Icons (brands)', count: 3446,
    load: () => import('./si').then((m) => m.ICONS) },
]
