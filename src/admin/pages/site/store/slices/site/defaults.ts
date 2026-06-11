/**
 * Default SiteDocument constructor + history sizing constants for the site slice.
 */

import { nanoid } from 'nanoid'
import {
  type Page,
  type SiteDocument,
  DEFAULT_BREAKPOINTS,
  DEFAULT_SITE_SETTINGS,
  createNode,
  createDefaultSiteExplorerOrganization,
} from '@core/page-tree'
import {
  clonePackageJson,
  DEFAULT_SITE_PACKAGE_JSON,
} from '@core/site-dependencies/manifest'
import {
  cloneSiteRuntimeConfig,
  DEFAULT_SITE_RUNTIME,
} from '@core/site-runtime'

/** Maximum undo history depth — prevents unbounded memory growth. */
export const MAX_HISTORY = 50

export function createDefaultSiteDocument(name: string): SiteDocument {
  const rootNode = createNode('base.body')
  const homePage: Page = {
    id: nanoid(),
    title: 'Home',
    slug: 'index',
    rootNodeId: rootNode.id,
    nodes: { [rootNode.id]: rootNode },
  }
  return {
    id: nanoid(),
    name,
    pages: [homePage],
    files: [],             // Contribution #595 — files data layer
    visualComponents: [],  // Contribution #619 — visual components data layer
    layouts: [],           // user-saved layouts data layer
    packageJson: clonePackageJson(DEFAULT_SITE_PACKAGE_JSON),
    runtime: cloneSiteRuntimeConfig(DEFAULT_SITE_RUNTIME),
    breakpoints: DEFAULT_BREAKPOINTS,
    settings: structuredClone(DEFAULT_SITE_SETTINGS),
    styleRules: {},
    explorer: createDefaultSiteExplorerOrganization(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}
