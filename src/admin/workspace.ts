/**
 * AdminWorkspace — top-level admin section identifier.
 *
 * Defined here (not in a concrete layout) so editor chrome (e.g. Toolbar)
 * can reference the type without creating cycles through layout modules.
 */
/**
 * `'dashboard'` is the admin home — the first page every user lands on. A
 * configurable widget grid (visitors, pages, posts, storage, plugins, …)
 * plus a setup-onboarding panel. Gated by `dashboard.read`.
 *
 * `'account'` is the user's own settings page (profile, devices, security,
 * activity). Self-targeted — no capability gate; every authenticated user
 * can access their own. The avatar dropdown in the toolbar is the primary
 * entry point.
 */
/**
 * `'ai'` is the AI provider settings + defaults workspace. Gated by
 * `ai.providers.manage` (or `ai.audit.read` for the read-only audit tab).
 */
/**
 * `'seo'` is the SEO & AEO workspace under the Tools nav dropdown
 * (`/admin/tools/seo`). Gated by `seo.read`.
 */
export type AdminWorkspace =
  | 'dashboard'
  | 'site'
  | 'content'
  | 'data'
  | 'media'
  | 'plugins'
  | 'users'
  | 'ai'
  | 'seo'
  | 'pluginPage'
  | 'account'
