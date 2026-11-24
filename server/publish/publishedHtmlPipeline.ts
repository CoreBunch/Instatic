/**
 * Single post-renderer pipeline applied to every HTML-emitting public path.
 *
 * Pages, post templates, and the fallback standalone data-row document
 * all feed their rendered output into this function. Adding a new
 * HTML-emitting code path means wiring it here, not duplicating injection
 * or hook-bus logic.
 *
 * Stages (in order, single-pass):
 *
 *   1. `publish.before` event — gives plugins a chance to set up per-page
 *      state (SEO Suite records the current pageId for its filter, etc.).
 *   2. `injectFrontendAssets` → `stampFormPageTokens` → `injectModuleScripts`
 *      — splices declarative `frontend.assets[]` tags from every enabled
 *      plugin at four placement anchors and rewrites the page CSP based on
 *      what's in the plan (pure host substrate: no host-shipped tag
 *      content); stamps the per-page HMAC token + page id onto CMS-native
 *      `<form>` tags; appends the page's module-JS `<script defer>` tags.
 *   3. `publish.html` filter — the escape hatch for non-tag mutations
 *      (link rewriting, redaction, JSON-LD enrichment). Plugins
 *      transform the document by string ops here.
 *   4. `publish.after` event — companion to `publish.before` so plugins
 *      can tear down their per-render bookkeeping.
 *
 * Architecture test `dispatcher-html-pipeline.test.ts` pins the contract:
 * every public-route handler that returns `content-type: text/html`
 * sources its body from this function (or is the admin-app shell, which
 * is gated separately).
 */

import type { DbClient } from '../db/client'
import { hookBus, type EveryRecipient, type HookRecipientCheck } from '@core/plugins/hookBus'
import { hostPluginHasPermission } from '../plugins/host/registry'
import {
  collectFrontendInjections,
  injectFrontendAssets,
} from './frontendInjections'
import { stampFormPageTokens } from '../forms/formRuntime'
import { injectModuleScripts } from './moduleJsBundle'
import type { RendererOutput } from './publicRenderer'

/**
 * Who a render is for. Every caller of the pipeline states it: this is the
 * one place that decides which plugins' `publish.html` filters may see the
 * HTML, so no caller can hand out a page by forgetting a flag.
 *
 *   - `public`  — a page anyone may open. Every registered filter runs and
 *     every listener hears `publish.before` / `publish.after`.
 *   - `member`  — a page behind an access rule (rendered for a member, or
 *     re-rendered in the background). Only plugins granted `members.read`
 *     filter it or hear that it was rendered: the events say which protected
 *     page a member just opened.
 *   - `preview` — unpublished work (a draft entry, a branch). No plugin
 *     filter and no publish event: a preview is not a publish, and a page can
 *     pull in drafts from any table, which nothing a plugin holds covers.
 *     Plugin frontend assets are still injected.
 *
 * The audience of a published route comes from its access rules
 * (`audienceForRules` / `pageAudience` in `accessGate.ts`).
 */
export type RenderAudience = 'public' | 'member' | 'preview'

/**
 * Which plugins may be told about, and handed, a render for `audience`.
 * `null`: none at all.
 */
function pluginRecipients(audience: RenderAudience): HookRecipientCheck | EveryRecipient | null {
  if (audience === 'preview') return null
  if (audience === 'member') return (pluginId) => hostPluginHasPermission(pluginId, 'members.read')
  return 'everyone'
}

/** What the pipeline reads of a render; the CSS bundle is the bake's concern. */
export type PublishedHtmlPipelineInput = Omit<RendererOutput, 'cssBundle'>

export async function applyPublishedHtmlPipeline(
  rendered: PublishedHtmlPipelineInput,
  db: DbClient,
  audience: RenderAudience,
): Promise<string> {
  const recipients = pluginRecipients(audience)
  const event = { siteId: rendered.siteId, pageId: rendered.pageId }
  if (recipients !== null) await hookBus.emit('publish.before', event, recipients)
  const injections = await collectFrontendInjections(db)
  const withInjections = injectFrontendAssets(rendered.html, injections)
  // Token stamping is an HTML mutation (needs the server signing secret) —
  // its own step, independent of JS injection.
  const withFormTokens = stampFormPageTokens(withInjections, rendered.pageId)
  // Module-JS channel: one external <script defer> per moduleId the page
  // needs; relaxes CSP script-src to 'self' iff at least one tag landed.
  const withModuleScripts = injectModuleScripts(withFormTokens, rendered.moduleScripts)
  if (recipients === null) return withModuleScripts
  const filtered = await hookBus.applyFilter('publish.html', withModuleScripts, {
    siteId: rendered.siteId,
    pageId: rendered.pageId,
    slug: rendered.slug,
  }, recipients)
  await hookBus.emit('publish.after', event, recipients)
  return filtered
}
