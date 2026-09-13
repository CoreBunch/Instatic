/**
 * Root scope — the default scope shown when the spotlight opens.
 *
 * Aggregates all built-in commands from the command registry.
 *
 * Phase 3: all 5 async providers fire in parallel when typing in the root
 * palette, so ⌘K → typing "home" returns the Home page row AND any Home
 * matches across content/media/data/plugins. Each provider is capped at 25
 * results; results are grouped by provider label.
 */

import type { Scope } from '../types'
import { getAllCommands } from '../builtinCommands'
import { pagesProvider } from '../providers/pagesProvider'
import { contentProvider } from '../providers/contentProvider'
import { mediaProvider } from '../providers/mediaProvider'
import { dataProvider } from '../providers/dataProvider'
import { pluginPagesProvider } from '../providers/pluginPagesProvider'
import { branchesProvider } from '../providers/branchesProvider'

export const rootScope: Scope = {
  id: 'root',
  placeholder: 'Type a command or search…',
  commands: () => getAllCommands(),
  providers: [
    pagesProvider,
    contentProvider,
    mediaProvider,
    dataProvider,
    pluginPagesProvider,
    branchesProvider,
  ],
}
