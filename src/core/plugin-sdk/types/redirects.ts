// ---------------------------------------------------------------------------
// Plugin-owned redirects — `api.cms.redirects`, gated by `redirects.manage`.
//
// A plugin keeps its own set of exact-path rules. The public router consults
// them only after every page, data row, disk artefact, and row-rename
// redirect has missed — just before the site's 404 page — so a rule never
// shadows live content. Rules are scoped to the plugin that wrote them and
// are removed when the plugin is uninstalled.
// ---------------------------------------------------------------------------

export type PluginRedirectStatus = 301 | 302 | 307 | 308 | 410

export interface PluginRedirectRuleInput {
  /** Exact request path (`/old`). A trailing slash is ignored (`/old/` = `/old`). */
  from: string
  /**
   * A path (`/new`) or an absolute `http:`/`https:` URL. Required for
   * 301/302/307/308; omit or pass `null` for 410.
   */
  to?: string | null
  status: PluginRedirectStatus
}

export interface PluginRedirectRule {
  /** The stored (normalized) path. */
  from: string
  to: string | null
  status: PluginRedirectStatus
  createdAt: string
  updatedAt: string
}

export interface ServerPluginRedirectsApi {
  /** This plugin's rules, ordered by `from`. */
  list(): Promise<PluginRedirectRule[]>
  /** Insert or update the rule for `rule.from`. */
  set(rule: PluginRedirectRuleInput): Promise<PluginRedirectRule>
  /** `true` when a rule was removed. */
  delete(from: string): Promise<boolean>
  /**
   * Atomically replace this plugin's whole rule set (max 5000). Every rule is
   * validated first; on any error nothing changes.
   */
  replaceAll(rules: PluginRedirectRuleInput[]): Promise<{ count: number }>
}
