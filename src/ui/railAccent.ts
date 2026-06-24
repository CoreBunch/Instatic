/**
 * railAccent — deterministic identity tinting for panel rail buttons.
 *
 * Unlike compact tag pills, rail buttons need the full panel identity rather
 * than the first letter: Site, Selectors, and Spacing should not all collapse
 * to the same color. The assignment helpers keep visible rail groups diverse
 * by avoiding repeats until the palette is exhausted.
 */

export const RAIL_ACCENTS = [
  'mint',
  'sky',
  'lilac',
  'peach',
  'rose',
  'lime',
  'gold',
  'cyan',
  'violet',
  'coral',
] as const

export type RailAccent = typeof RAIL_ACCENTS[number]

const DEFAULT_RAIL_ACCENT: RailAccent = 'mint'
const RAIL_ACCENT_TOKEN: Record<RailAccent, string> = {
  mint: 'var(--accent-1)',
  sky: 'var(--accent-3)',
  lilac: 'var(--accent-2)',
  peach: 'var(--accent-4)',
  rose: 'var(--accent-5)',
  lime: 'var(--accent-6)',
  gold: 'var(--accent-7)',
  cyan: 'var(--accent-8)',
  violet: 'var(--accent-9)',
  coral: 'var(--accent-10)',
}

function hashIdentity(value: string): number {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return 0

  let hash = 2166136261
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function railAccent(identity: string): RailAccent {
  const index = hashIdentity(identity) % RAIL_ACCENTS.length
  return RAIL_ACCENTS[index] ?? DEFAULT_RAIL_ACCENT
}

export function railTintVar(accent: RailAccent): string {
  return RAIL_ACCENT_TOKEN[accent]
}

export function assignRailAccents<TItem>(
  items: readonly TItem[],
  identityForItem: (item: TItem) => string,
  explicitAccentForItem?: (item: TItem) => RailAccent | null | undefined,
): RailAccent[] {
  const used = new Set<RailAccent>()

  return items.map((item) => {
    const explicitAccent = explicitAccentForItem?.(item)
    if (explicitAccent) {
      used.add(explicitAccent)
      return explicitAccent
    }

    const startIndex = hashIdentity(identityForItem(item)) % RAIL_ACCENTS.length
    for (let offset = 0; offset < RAIL_ACCENTS.length; offset += 1) {
      const candidate = RAIL_ACCENTS[(startIndex + offset) % RAIL_ACCENTS.length]
      if (candidate && !used.has(candidate)) {
        used.add(candidate)
        return candidate
      }
    }

    return RAIL_ACCENTS[startIndex] ?? DEFAULT_RAIL_ACCENT
  })
}
