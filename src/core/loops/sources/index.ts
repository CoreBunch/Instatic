/**
 * Built-in loop sources self-register on import, mirroring how base
 * modules register in `src/modules/base/index.ts`.
 *
 * Imported once from `src/admin/AdminEntry.tsx` (admin chunk) and from
 * `server/publish/publicRenderer.ts` (server) so the registry is populated
 * before any loop renders.
 */

import { loopSourceRegistry } from '@core/loops/registry'
import { DataRowsSource } from './dataRows'
import { SitePagesSource } from './sitePages'
import { SiteMediaSource } from './siteMedia'
import { EntryFieldSource } from './entryField'

loopSourceRegistry.registerOrReplace(DataRowsSource)
loopSourceRegistry.registerOrReplace(SitePagesSource)
loopSourceRegistry.registerOrReplace(SiteMediaSource)
loopSourceRegistry.registerOrReplace(EntryFieldSource)
