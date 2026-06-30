import type { SiteExplorerSectionId } from '@core/page-tree'
import type {
  SiteExplorerStructuralSectionModel,
  SiteExplorerTreeSectionModel,
} from './siteExplorerModel'

export type SiteExplorerContextTarget =
  | { kind: 'page'; id: string; title: string; slug: string }
  | { kind: 'component'; id: string; name: string }
  | { kind: 'file'; id: string; path: string }
  | { kind: 'folder'; sectionId: SiteExplorerSectionId; id: string; name: string }

export type SiteExplorerAnySectionModel =
  | SiteExplorerTreeSectionModel<SiteExplorerContextTarget>
  | SiteExplorerStructuralSectionModel<SiteExplorerContextTarget>

/**
 * Which group of sections the panel renders. The consolidated Explorer panel
 * splits the site concepts across two tabs:
 *   - `site` — Pages, Templates, Components (renderable site structure)
 *   - `code` — Styles, Scripts (raw source files opened in the editor)
 * Both groups are served by a single `SiteExplorerPanel` instance (shared DnD
 * scope + selection), switched by the active Explorer tab.
 */
export type SiteExplorerSectionGroup = 'site' | 'code'
