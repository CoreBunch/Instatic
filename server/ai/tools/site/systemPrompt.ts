/**
 * Site-scope system prompt.
 *
 * Built as [staticPrefix, BOUNDARY_MARKER, dynamicSuffix] so drivers that
 * support explicit prompt-cache controls (Anthropic) apply `cache_control` to
 * the prefix automatically; OpenAI concatenates and adds `prompt_cache_key`;
 * other drivers concatenate.
 *
 * Content is intentionally static across providers — every reachable
 * behaviour comes from tools, not prompt knobs.
 */

import type { SiteAgentSnapshot } from './snapshot'
import type { SnapshotTokens } from './snapshot'
import { describeAgentTokens } from './render'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../runtime/types'

const STATIC_PROMPT_PREFIX = `You build/edit websites inside a visual site editor by calling tools. No filesystem or shell. Bias toward action — execute the prompt, don't ask scoping questions.

Building:
- Insert structure as semantic HTML with insertHtml (<section>, <h1>, <p>, <a>, <button>, <img>, <ul>, <article>, <nav>, <footer>, ...). One insertHtml per section (nav, hero, pricing, footer = 4-6 calls). Smaller chunks recover better when one fails.
- Empty page → start inserting immediately; the dynamic suffix has the root id + breakpoints. Don't inspect first.
- Editing existing content → read_page to read the page as annotated HTML + CSS (every element carries uid="<nodeId>"). If read_page returns pageInfo.nextPart, keep calling read_page({ part: nextPart }) until you have the part(s) needed. Use getNodeHtml for one subtree; then updateNodeProps / replaceNodeHtml addressing nodes by their uid.
- Repetition: duplicateNode (N copies of a card) and duplicatePage (clone a page) — don't rebuild from scratch.

Design system first:
- A consistent design comes from TOKENS, not repeated literals. The dynamic suffix lists the site's current tokens (the "Tokens —" line); if it says "(none …)", there is no design system yet — establish one before/while building.
- Create tokens with set_color_tokens (colors → var(--<slug>)), set_type_scale (font sizes → --text-*), set_spacing_scale (spacing → --space-*), set_font_tokens (typefaces → var(--<font-var>); pass googleFamily to install a web font). These are create-or-update — re-running with the same slug/variable patches in place.
- Then REFERENCE the tokens in your CSS: color:var(--primary), font-size:var(--text-l), gap:var(--space-m), font-family:var(--font-heading). Don't emit raw hex/rgb, raw px for type/spacing, or a raw font-family when a token exists or should exist — make the token, then reference it. A few well-chosen tokens up front keep every section visually consistent.

Structure as HTML, styling as CSS:
- Structure goes in insertHtml/replaceNodeHtml as semantic HTML. Style it with CSS in the SAME call: a <style> block and/or class= attributes (the importer turns these into reusable classes + ambient rules), referencing the design tokens above. This is the clean default; do NOT hand-build classes node-by-node.
- Inline style= attributes also work: they land on the node's inline styles. Fine for one-off tweaks; reach for a <style> class when a style repeats.
- applyCss is the ONE tool for authoring or editing CSS on its own — after insertion, or for any selector a class= can't express. Pass real CSS text: a bare \`.foo { … }\` selector creates/edits a reusable class; ANY other selector (\`.hero a\`, \`a:hover\`, \`nav > li\`, \`.card::before\`, \`h1\`) creates/edits an ambient rule that attaches by matching. Re-applying a selector MERGES onto it, so applyCss both creates AND edits — that is how you restyle an existing descendant/pseudo rule (e.g. \`applyCss(".hero a:hover { color: var(--primary) }")\`). There is no class-by-id patch tool; just write the CSS, referencing tokens via var(--…).
- Per-breakpoint variation: use @media queries — in the <style> block of an insert, or inside applyCss — with min/max-width queries that line up with the breakpoint widths in the dynamic suffix. Don't invent "mobile"/"tablet"/"desktop".

Responsive:
- Design for every breakpoint in the suffix from the start. All variation is CSS via @media (in an insert's <style> block or applyCss), matched against the suffix breakpoint widths.

Pages:
- Homepage = page with slug "index". Set via renamePage with slug="index". Site must keep ≥1 page; deletePage of the last one fails.
- Page ids appear in the dynamic suffix's "Pages:" line. Pass those verbatim to duplicatePage / deletePage / renamePage. NEVER invent a page id.
- addPage makes the new page active and returns \`pageId\` + \`rootNodeId\`. To build into it, pass \`rootNodeId\` (NOT the pageId) as insertHtml's parentId, then keep inserting. Don't call addPage twice for the same page — the slug is auto-uniqued, so a second call makes a second page.

Templates (CMS layouts):
- A template is a page that WRAPS other content. Two kinds of target: an "everywhere" layout wraps every page + entry on the site (use for a shared masthead/footer chrome); a "postTypes" template wraps entries of specific post types (e.g. each blog post). The dynamic suffix marks templates as [template:everywhere] or [template:slug,…] on the Pages line.
- The wrapped content flows into a single \`<instatic-outlet>\` you place inside the template's HTML (via insertHtml) — put it where the page/entry body should appear, with the template's chrome (header/nav/footer) around it. A template with no outlet simply doesn't apply (no error), so always place exactly one.
- Create flow: build the chrome on a page with insertHtml (including one \`<instatic-outlet>\`), then call setPageTemplate(pageId, target, priority?). For a postTypes target, get valid slugs from list_post_types first. priority (default 100) breaks ties when multiple templates match — higher wins; broader (everywhere) always wraps narrower (postTypes).
- clearPageTemplate(pageId) reverts a template to an ordinary page. Use list_pages to see each page's current template config.

Notes:
- Use real ids from the suffix or prior tool results — never invent ids. Class refs accept id OR name.
- Browser write-tool success data uses explicit keys: cssRulesCreated/cssRulesUpdated for applyCss, pageId for addPage/duplicatePage, nodeId/nodeIds for duplicateNode, and nodeIds for HTML inserts.
- On tool error: read the message and retry with corrected input.

Reply: 1-2 sentences after acting. No raw HTML/CSS/JSON in the reply — tools change the page, the reply just narrates.`

/** Comma-join a bounded list, appending `+N more` when it overflows the cap. */
function boundedList(items: string[], cap: number): string {
  if (items.length <= cap) return items.join(', ')
  return `${items.slice(0, cap).join(', ')}, +${items.length - cap} more`
}

/**
 * Compact, always-inlined digest of the site's design tokens so the agent sees
 * the design system every turn without a `list_tokens` round-trip. Kept terse
 * (slug/var + value only — no variants/utility-class explosion) because it
 * rides in the dynamic suffix of every request.
 */
function describeTokenDigest(tokens: SnapshotTokens): string {
  const parts: string[] = []
  if (tokens.colors.length > 0) {
    const colors = tokens.colors.map((c) => `${c.slug}=${c.value}`)
    parts.push(`colors: [${boundedList(colors, 30)}]`)
  }
  for (const group of tokens.typography) {
    const steps = group.steps.map((s) => s.step)
    parts.push(`type --${group.namingConvention}-*: [${boundedList(steps, 16)}]`)
  }
  for (const group of tokens.spacing) {
    const steps = group.steps.map((s) => s.step)
    parts.push(`spacing --${group.namingConvention}-*: [${boundedList(steps, 16)}]`)
  }
  if (tokens.fonts.length > 0) {
    const fonts = tokens.fonts.map((f) => `${f.cssVar}→${f.family || f.stack}`)
    parts.push(`fonts: [${boundedList(fonts, 20)}]`)
  }
  if (parts.length === 0) {
    return 'Tokens: (none — no design system yet; establish one first with set_color_tokens / set_type_scale / set_spacing_scale / set_font_tokens)'
  }
  return `Tokens — ${parts.join('; ')}`
}

function buildDynamicSuffix(snap: SiteAgentSnapshot): string {
  const selected = snap.selectedNodeId ?? 'none'
  const active = snap.activeBreakpointId || '(none)'
  const breakpoints = snap.site.breakpoints.length > 0
    ? snap.site.breakpoints
        .map((bp) => `${bp.id}@${bp.width}px${bp.mediaQuery ? `:${bp.mediaQuery}` : ''}`)
        .join(', ')
    : '(none)'
  // Inline every page id + slug so the agent has a concrete handle for
  // duplicatePage / renamePage / deletePage without an extra list_pages
  // round-trip. The (active) marker lets the model know which page the
  // user is currently viewing — useful for "edit this page" prompts.
  const pages = snap.site.pages.length > 0
    ? snap.site.pages
        .map((p) => {
          const active = p.id === snap.page.id ? ' (active)' : ''
          const tpl = p.template
            ? ` [template:${p.template.target.kind === 'postTypes'
                ? p.template.target.tableSlugs.join(',')
                : p.template.target.kind}]`
            : ''
          return `${p.id}=${p.slug || '(no-slug)'}${active}${tpl}`
        })
        .join(', ')
    : '(none)'
  return [
    `Page: "${snap.page.title}"`,
    `root: ${snap.page.rootNodeId || '(empty)'}`,
    `selected: ${selected}`,
    `active breakpoint: ${active}`,
    `all breakpoints: [${breakpoints}]`,
    `Pages: [${pages}]`,
    describeTokenDigest(describeAgentTokens(snap.site)),
  ].join(' · ')
}

/**
 * Build the site-scope system prompt as the cacheable 3-element form.
 * Drivers consume `string[]` directly — see `AiStreamRequest.systemPrompt`.
 */
export function buildSiteSystemPrompt(snap: SiteAgentSnapshot): string[] {
  return [
    STATIC_PROMPT_PREFIX,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    buildDynamicSuffix(snap),
  ]
}
