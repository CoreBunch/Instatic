/**
 * Site-scope write tools — browser-bridged. The runner emits a
 * `toolRequest` for each call and waits for the browser to POST a result
 * to /admin/api/ai/tool-result.
 *
 * Each tool defines only `name`, `description`, `inputSchema`, and the
 * sentinel `execution: 'browser'`. There is NO server-side handler — the
 * runner routes browser-execution tools through the bridge instead.
 *
 * Node/class/page/template mutation tools + design-system token tools +
 * render_snapshot + getNodeHtml (22 total).
 *
 * The input schemas are the single source of truth in `@core/ai`
 * (`src/core/ai/toolSchemas.ts`). This module imports each `*InputSchema`
 * for its tool `inputSchema`; the browser executor at
 * `src/admin/pages/site/agent/executor.ts` imports the SAME schemas to
 * validate each call. Neither side redeclares them, so a constraint added
 * here is enforced in the browser too — at build time.
 */

import {
  InsertHtmlInputSchema,
  GetNodeHtmlInputSchema,
  ReplaceNodeHtmlInputSchema,
  DeleteNodeInputSchema,
  UpdateNodePropsInputSchema,
  MoveNodeInputSchema,
  RenameNodeInputSchema,
  DuplicateNodeInputSchema,
  ApplyCssInputSchema,
  AssignClassInputSchema,
  RemoveClassInputSchema,
  AddPageInputSchema,
  DeletePageInputSchema,
  RenamePageInputSchema,
  DuplicatePageInputSchema,
  SetPageTemplateInputSchema,
  ClearPageTemplateInputSchema,
  SetColorTokensInputSchema,
  SetFontTokensInputSchema,
  SetTypeScaleInputSchema,
  SetSpacingScaleInputSchema,
  RenderSnapshotInputSchema,
} from '@core/ai'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'

// ---------------------------------------------------------------------------
// Capability requirements (ANY-OF) — mirror the editor's change-class model
// (structure / content / style — see server/handlers/cms/siteDiff.ts and the
// `site.structure.edit` gate on PUT /admin/api/cms/pages). Selection-time
// gating only: persistence is independently re-validated server-side.
// `getNodeHtml` and `render_snapshot` are reads of the browser snapshot and
// stay ungated beyond the toolset's own write/read split.
// ---------------------------------------------------------------------------

const SITE_STRUCTURE_CAPS: readonly CoreCapability[] = ['site.structure.edit']

// Prop/label edits are the copy-editor surface; a structural editor may make
// them too.
const SITE_CONTENT_CAPS: readonly CoreCapability[] = [
  'site.content.edit',
  'site.structure.edit',
]

const SITE_STYLE_CAPS: readonly CoreCapability[] = ['site.style.edit']

// ---------------------------------------------------------------------------
// HTML-native write tools
// ---------------------------------------------------------------------------

const insertHtmlTool: AiTool = {
  name: 'insertHtml',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Insert semantic HTML as a subtree of editable nodes under an existing parent. Write structure as HTML (<section>, <h1>, <a>, <button>, <img>, <ul>, ...) and style it with CSS in the same call: put a <style> block in the HTML and/or class= attributes. The importer parses every rule — a bare `.foo {}` selector becomes a reusable Selectors-panel class bound to class="foo"; any other selector (`.hero a`, `a:hover`, `nav > li`) becomes an ambient rule. Inline style= attributes land on the node\'s inline styles. To author or edit CSS on its own — pseudo/hover/descendant selectors, or restyling existing rules — use the dedicated applyCss tool instead (insertHtml is for inserting structure).',
  inputSchema: InsertHtmlInputSchema,
}

const getNodeHtmlTool: AiTool = {
  name: 'getNodeHtml',
  scope: 'site',
  execution: 'browser',
  description:
    'Return the current HTML the published page would emit for a node subtree. Use before replaceNodeHtml to read existing structure.',
  inputSchema: GetNodeHtmlInputSchema,
}

const replaceNodeHtmlTool: AiTool = {
  name: 'replaceNodeHtml',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    "Replace a node subtree's children with new HTML. The target node is preserved as the parent; its existing children are rebuilt from the HTML. Style with CSS exactly as in insertHtml: a <style> block and/or class= attributes; bare `.foo` selectors become reusable classes, other selectors become ambient rules. To author or edit CSS on its own (without rebuilding children), use the dedicated applyCss tool instead.",
  inputSchema: ReplaceNodeHtmlInputSchema,
}

// ---------------------------------------------------------------------------
// Node-level write tools
// ---------------------------------------------------------------------------

const deleteNodeTool: AiTool = {
  name: 'deleteNode',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Remove a node and its descendants. Not undoable from inside the loop (user can Cmd+Z after).',
  inputSchema: DeleteNodeInputSchema,
}

const updateNodePropsTool: AiTool = {
  name: 'updateNodeProps',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_CONTENT_CAPS,
  description:
    'Shallow-merge a patch onto an existing node\'s props. `breakpointId` is only valid for props marked `breakpointOverridable` in the schema (rejected for content props like text/tag/src). For per-breakpoint visual variation use applyCss with an `@media` query, not this. Richtext props are auto-sanitised.',
  inputSchema: UpdateNodePropsInputSchema,
}

const moveNodeTool: AiTool = {
  name: 'moveNode',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    "Move a node to a different parent and/or position. `newIndex` is 0-based among the destination's children.",
  inputSchema: MoveNodeInputSchema,
}

const renameNodeTool: AiTool = {
  name: 'renameNode',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_CONTENT_CAPS,
  description:
    "Set the node's display label in the DOM tree panel. Editor-only; doesn't affect rendered HTML.",
  inputSchema: RenameNodeInputSchema,
}

const duplicateNodeTool: AiTool = {
  name: 'duplicateNode',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    "Deep-clone a node + subtree (props, classIds, breakpoint overrides) right after the original. `count` (1-50, default 1) produces N clones in one call. Success data includes the first new node id as `nodeId` and all new ids as `nodeIds`.",
  inputSchema: DuplicateNodeInputSchema,
}

// ---------------------------------------------------------------------------
// CSS + class-assignment write tools
// ---------------------------------------------------------------------------

const applyCssTool: AiTool = {
  name: 'applyCss',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Author or edit CSS — the single tool for ALL styling that isn\'t attached inline. Pass real CSS text and it is parsed and UPSERTED into the site: a bare `.foo { … }` selector creates or edits a reusable class (bound to class="foo"); ANY other selector — descendant (`.hero a`), child (`nav > li`), pseudo-class/element (`a:hover`, `.card::before`), attribute, element (`h1`) — creates or edits an ambient rule that attaches by matching, no class attribute needed. `@media` queries fold into per-breakpoint overrides (matched against the site breakpoints); other `@media`/`@supports`/`@container` round-trip as reusable conditions. Re-applying a selector MERGES onto the existing rule, so this both creates new styles and edits existing ones (e.g. `.hero a:hover { color: var(--primary) }` to restyle an existing descendant rule). Reference design tokens — `var(--primary)`, `var(--text-l)`, `var(--space-m)` — not raw hex/px. A reusable class is just a bare `.name` selector (a CSS identifier, no spaces). Success data: `{ cssRulesCreated, cssRulesUpdated }`.',
  inputSchema: ApplyCssInputSchema,
}

const assignClassTool: AiTool = {
  name: 'assignClass',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    "Attach an existing CSS class to a node. `classId` accepts id or name.",
  inputSchema: AssignClassInputSchema,
}

const removeClassTool: AiTool = {
  name: 'removeClass',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Detach a class from a node (the class itself is not deleted). `classId` accepts id or name.',
  inputSchema: RemoveClassInputSchema,
}

// ---------------------------------------------------------------------------
// Page-level write tools
// ---------------------------------------------------------------------------

const addPageTool: AiTool = {
  name: 'addPage',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Add an EMPTY page and make it the active page. `slug` defaults to a slugified title and is auto-uniqued (a repeat add becomes `-2`, `-3`) — so never call addPage twice for the same page. Success data: `pageId` and `rootNodeId`. To build into the new page, pass `rootNodeId` as insertHtml\'s `parentId` — a pageId is NOT a node id. The page is already active, so just start inserting; no need to read_page/list_pages first. For copying an existing page use duplicatePage.',
  inputSchema: AddPageInputSchema,
}

const deletePageTool: AiTool = {
  name: 'deletePage',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Permanently delete a page. Fails if it would leave the site with zero pages.',
  inputSchema: DeletePageInputSchema,
}

const renamePageTool: AiTool = {
  name: 'renamePage',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    "Change a page's title and/or slug. `slug=\"index\"` makes this page the homepage. Omit slug to keep it.",
  inputSchema: RenamePageInputSchema,
}

const duplicatePageTool: AiTool = {
  name: 'duplicatePage',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Deep-clone an existing page (every node, prop, class assignment, breakpoint override) under a new title/slug. Node ids are regenerated; class assignments preserved. Success data includes the new id as `pageId`.',
  inputSchema: DuplicatePageInputSchema,
}

// ---------------------------------------------------------------------------
// Template write tools — convert a page to/from a CMS template.
//
// A template is a page carrying a `target` (an `everywhere` layout, or one/more
// post types) plus a single `<instatic-outlet>` where matched content flows in.
// These mirror the editor's convertPageToTemplate / convertTemplateToPage store
// actions; the browser bridge applies them. Targets mirror TemplateTargetSchema
// in `@core/page-tree`.
// ---------------------------------------------------------------------------

const setPageTemplateTool: AiTool = {
  name: 'setPageTemplate',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Turn a page INTO a template (or update an existing template\'s target/priority). `target` is `{kind:"everywhere"}` for a site-wide layout that wraps every page+entry, `{kind:"postTypes", tableSlugs:[…]}` to wrap entries of those post types (slugs from list_post_types), or `{kind:"notFound"}` for the page served on public 404s (status 404, wrapped by the everywhere layout; needs no outlet). `priority` (default 100) breaks ties when several templates match at the same breadth level — higher wins. An everywhere/postTypes template needs exactly one `<instatic-outlet>` (insert it via insertHtml) marking where matched content flows; a wrapper template with no outlet simply doesn\'t apply. Pass a real page id from the suffix / list_pages.',
  inputSchema: SetPageTemplateInputSchema,
}

const clearPageTemplateTool: AiTool = {
  name: 'clearPageTemplate',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Revert a template back to an ordinary page: drops its template target and any dynamic bindings. The `<instatic-outlet>` node (if any) stays — delete it separately if unwanted. No-op error if the page is not a template.',
  inputSchema: ClearPageTemplateInputSchema,
}

// ---------------------------------------------------------------------------
// Design-system token write tools — create/update framework + font tokens.
//
// Colors and fonts are LIST-shaped (one entry per token); typography and
// spacing are SCALE-shaped (a group config from which the framework generates
// per-step values).
// ---------------------------------------------------------------------------

const setColorTokensTool: AiTool = {
  name: 'set_color_tokens',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Create or update framework COLOR tokens — the source of truth for color. Each `{ slug, lightValue }` becomes `var(--<slug>)` plus generated utility classes (text-/bg-/border-) and shade/tint variants. Create-or-update is keyed by `slug`: an existing slug is patched, a new one is created. `lightValue` is any CSS color (hex/rgb/hsl); omit `darkValue` to auto-generate it. Establish color tokens before styling and reference them as `var(--<slug>)` instead of raw hex.',
  inputSchema: SetColorTokensInputSchema,
}

const setFontTokensTool: AiTool = {
  name: 'set_font_tokens',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Create or update FONT tokens — named typefaces referenced as `var(--<variable>)`. Pass `googleFamily` (e.g. "Inter") to install a new Google web font (downloads the files, then binds the token to it); `variants` defaults to ["400","700"] and `subsets` to ["latin"]. Pass `familyId` to reference an already-installed family. Pass neither for a fallback-only/system token. Create-or-update is keyed by `variable` (defaults from `name`). `googleFamily` and `familyId` are mutually exclusive.',
  inputSchema: SetFontTokensInputSchema,
}

const setTypeScaleTool: AiTool = {
  name: 'set_type_scale',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Configure the TYPOGRAPHY scale — the fluid type ramp generating `--text-*` variables (default prefix "text"). A scale is a config: `min`/`max` give the base `fontSize` (px) and `scaleRatio` at the small/large screen anchors; `steps` is the comma-separated step list (e.g. "xs,s,m,l,xl,2xl,3xl,4xl") and `baseScaleIndex` picks which step equals the base size. Creates the group if none exists, else updates it (target a specific one with `groupId`). Reference sizes as `var(--text-l)` rather than raw px.',
  inputSchema: SetTypeScaleInputSchema,
}

const setSpacingScaleTool: AiTool = {
  name: 'set_spacing_scale',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Configure the SPACING scale — the fluid spacing ramp generating `--space-*` variables (default prefix "space"). Same shape as set_type_scale but `min`/`max` carry `size` (px) instead of `fontSize`; `steps` defaults to an 11-step scale and `baseScaleIndex` to 5 ("m"). Creates the group if none exists, else updates it. Reference gaps/padding as `var(--space-l)` rather than raw px.',
  inputSchema: SetSpacingScaleInputSchema,
}

// ---------------------------------------------------------------------------
// render_snapshot — browser-bridged, returns a special payload
// ---------------------------------------------------------------------------

const renderSnapshotTool: AiTool = {
  name: 'render_snapshot',
  scope: 'site',
  execution: 'browser',
  description:
    "Inspect the rendered canvas. Returns a layout report: viewport size, per-node bounding boxes, image-load status, and warnings (overflow / broken-image / invisible-node) — enough to catch most layout bugs in text. On a vision-capable model a screenshot is also attached as an image. Pass `breakpointId` to choose which breakpoint frame (defaults to active). Pass `nodeId` to capture just that node's subtree — a sharper, cheaper image than the whole page, and a report scoped to that section with coordinates relative to the node; omit `nodeId` to capture the full page.",
  inputSchema: RenderSnapshotInputSchema,
}

// ---------------------------------------------------------------------------
// All write tools — convenient barrel for the registry
// ---------------------------------------------------------------------------

export const siteWriteTools: AiTool[] = [
  insertHtmlTool,
  getNodeHtmlTool,
  replaceNodeHtmlTool,
  deleteNodeTool,
  updateNodePropsTool,
  moveNodeTool,
  renameNodeTool,
  duplicateNodeTool,
  applyCssTool,
  assignClassTool,
  removeClassTool,
  addPageTool,
  deletePageTool,
  renamePageTool,
  duplicatePageTool,
  setPageTemplateTool,
  clearPageTemplateTool,
  setColorTokensTool,
  setFontTokensTool,
  setTypeScaleTool,
  setSpacingScaleTool,
  renderSnapshotTool,
]
