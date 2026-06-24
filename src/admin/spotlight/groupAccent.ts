/**
 * groupAccent — maps a CommandGroup to a categorical accent.
 *
 * Mirrors the module inserter's section accents (lilac / sky / mint / peach /
 * rose …) so the command palette reads as the same design family: each group
 * gets a stable identity color used for its icon chip and header bar.
 *
 * The returned value is the `data-accent` token consumed by Spotlight.module.css
 * (`[data-accent="mint"]` → `--spotlightAccent`).
 */

import type { CommandGroup } from './types'

type SpotlightAccent =
  | 'mint'
  | 'lilac'
  | 'sky'
  | 'peach'
  | 'rose'
  | 'lime'
  | 'gold'
  | 'cyan'
  | 'violet'
  | 'coral'

const GROUP_ACCENT: Record<CommandGroup, SpotlightAccent> = {
  navigation: 'sky',
  editor: 'lilac',
  pages: 'mint',
  content: 'lime',
  data: 'gold',
  media: 'peach',
  visualComponents: 'violet',
  framework: 'cyan',
  plugins: 'coral',
  users: 'sky',
  account: 'peach',
  settings: 'lilac',
  preview: 'cyan',
  ai: 'violet',
  help: 'gold',
  recent: 'rose',
  results: 'lilac',
}

export function groupAccent(group: CommandGroup): SpotlightAccent {
  return GROUP_ACCENT[group] ?? 'lilac'
}
