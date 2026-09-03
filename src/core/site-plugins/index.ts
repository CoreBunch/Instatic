/**
 * @core/site-plugins — source model for developer-authored site plugins.
 *
 * Discovery over draft `SiteFile[]`, author-manifest validation + runtime
 * manifest derivation, content hashing, scaffold templates, and the
 * runtime-state machine shared by the server list endpoint and the admin
 * UI. Feature doc: docs/features/site-plugins.md.
 */
export {
  SITE_PLUGIN_DERIVED_FIELDS,
  SITE_PLUGIN_LOCAL_ID_PATTERN,
  SITE_PLUGIN_SOURCE_ROOT,
  SitePluginDraftManifestSchema,
  localIdFromSitePluginId,
  sitePluginFolder,
  sitePluginIdFromLocalId,
  sitePluginLocalIdFromName,
  type SitePluginDraftManifest,
} from './schemas'
export { discoverSitePlugins, type DiscoveredSitePlugin } from './discover'
export {
  computeSitePluginContentHash,
  contentHashOfVersion,
  deriveSitePluginManifest,
  nextSitePluginVersion,
  sitePluginDisplayVersion,
  type DeriveSitePluginManifestInput,
} from './derive'
export {
  SITE_PLUGIN_TEMPLATE_IDS,
  SITE_PLUGIN_TEMPLATES,
  sitePluginTemplateFiles,
  type SitePluginTemplateFile,
  type SitePluginTemplateId,
  type SitePluginTemplateInfo,
} from './templates'
export {
  SITE_PLUGIN_RUNTIME_STATES,
  SitePluginRevisionSchema,
  SitePluginRuntimeStateSchema,
  SitePluginSummarySchema,
  SitePluginsPayloadSchema,
  computeSitePluginState,
  sitePluginPrimaryAction,
  sitePluginStateLabel,
  type SitePluginPrimaryAction,
  type SitePluginPrimaryActionKind,
  type SitePluginRevision,
  type SitePluginRuntimeState,
  type SitePluginStateInput,
  type SitePluginSummary,
  type SitePluginsPayload,
} from './state'
