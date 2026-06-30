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
 * browser-backed read/orientation tools (site_read_document, site_open_document,
 * site_render_snapshot, site_get_node_html).
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
  ReadDocumentInputSchema,
  OpenDocumentInputSchema,
  ReplaceNodeHtmlInputSchema,
  DeleteNodeInputSchema,
  UpdateNodePropsInputSchema,
  MoveNodeInputSchema,
  RenameNodeInputSchema,
  DuplicateNodeInputSchema,
  ApplyCssInputSchema,
  AssignClassInputSchema,
  RemoveClassInputSchema,
  ListCodeAssetsInputSchema,
  ReadCodeAssetInputSchema,
  WriteCodeAssetInputSchema,
  PatchCodeAssetInputSchema,
  InspectCodeRuntimeInputSchema,
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
// `site_get_node_html`, `site_read_document`, `site_open_document`, and `site_render_snapshot` are
// reads/orientation tools backed by the browser snapshot and stay ungated
// beyond the toolset's own write/read split.
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
  name: 'site_insert_html',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Insert semantic HTML as a subtree of editable nodes under an existing parent. Write structure as HTML (<section>, <h1>, <a>, <button>, <img>, <ul>, ...) and style it with CSS in the same call: put a <style> block in the HTML and/or class= attributes. Custom importer markers: <instatic-loop data-source-id="…" ...> creates a real Loop node (call site_list_loop_sources first for source/table ids and {currentEntry.*} tokens); <instatic-outlet> creates a template content outlet. The importer parses every rule — a bare `.foo {}` selector becomes a reusable Selectors-panel class bound to class="foo"; any other selector (`.hero a`, `a:hover`, `nav > li`) becomes an ambient rule. Inline style= attributes land on the node\'s inline styles. To author or edit CSS on its own — pseudo/hover/descendant selectors, or restyling existing rules — use the dedicated site_apply_css tool instead (site_insert_html is for inserting structure). Returns `nodeIds` (the inserted roots) and `created` — every inserted node as { id, moduleId, classes } — so you can target a nested node (e.g. the wrapper you just added) without re-reading the whole tree.',
  inputSchema: InsertHtmlInputSchema,
}

const getNodeHtmlTool: AiTool = {
  name: 'site_get_node_html',
  scope: 'site',
  execution: 'browser',
  description:
    'Return the current HTML the published page would emit for a node subtree. Use before site_replace_node_html to read existing structure.',
  inputSchema: GetNodeHtmlInputSchema,
}

const readDocumentTool: AiTool = {
  name: 'site_read_document',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: ['site.read'],
  description:
    'Read any editable document as annotated HTML + relevant CSS without switching the visible canvas. Pass a document ref from site_list_documents; omit document to read the current document. If pageInfo.nextPart is not null, call site_read_document again with the same document and part.',
  inputSchema: ReadDocumentInputSchema,
}

const openDocumentTool: AiTool = {
  name: 'site_open_document',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: ['site.read'],
  description:
    'Visibly open a page/template/visual component document in the editor. Use before site_render_snapshot or when the user asks to navigate. For background inspection, prefer site_read_document because it does not move the canvas.',
  inputSchema: OpenDocumentInputSchema,
}

const replaceNodeHtmlTool: AiTool = {
  name: 'site_replace_node_html',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    "Replace a node subtree's children with new HTML. The target node is preserved as the parent; its existing children are rebuilt from the HTML. Style with CSS exactly as in site_insert_html: a <style> block and/or class= attributes; bare `.foo` selectors become reusable classes, other selectors become ambient rules. Custom importer markers work here too: <instatic-loop data-source-id=\"…\" ...> creates a real Loop node and <instatic-outlet> creates a template content outlet. To author or edit CSS on its own (without rebuilding children), use the dedicated site_apply_css tool instead.",
  inputSchema: ReplaceNodeHtmlInputSchema,
}

// ---------------------------------------------------------------------------
// Node-level write tools
// ---------------------------------------------------------------------------

const deleteNodeTool: AiTool = {
  name: 'site_delete_node',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Remove a node and its descendants. Not undoable from inside the loop (user can Cmd+Z after).',
  inputSchema: DeleteNodeInputSchema,
}

const updateNodePropsTool: AiTool = {
  name: 'site_update_node_props',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_CONTENT_CAPS,
  description:
    'Shallow-merge a patch onto an existing node\'s props. `breakpointId` is only valid for props marked `breakpointOverridable` in the schema (rejected for content props like text/tag/src). For per-breakpoint visual variation use site_apply_css with an `@media` query, not this. Richtext props are auto-sanitised.',
  inputSchema: UpdateNodePropsInputSchema,
}

const moveNodeTool: AiTool = {
  name: 'site_move_node',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    "Move a node to a different parent and/or position. `newIndex` is 0-based among the destination's children.",
  inputSchema: MoveNodeInputSchema,
}

const renameNodeTool: AiTool = {
  name: 'site_rename_node',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_CONTENT_CAPS,
  description:
    "Set the node's display label in the DOM tree panel. Editor-only; doesn't affect rendered HTML.",
  inputSchema: RenameNodeInputSchema,
}

const duplicateNodeTool: AiTool = {
  name: 'site_duplicate_node',
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
  name: 'site_apply_css',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Author or edit CSS — the single tool for ALL styling that isn\'t attached inline. Pass real CSS text and it is parsed and UPSERTED into the site: a bare `.foo { … }` selector creates or edits a reusable class (bound to class="foo"); ANY other selector — descendant (`.hero a`), child (`nav > li`), pseudo-class/element (`a:hover`, `.card::before`), attribute, element (`h1`) — creates or edits an ambient rule that attaches by matching, no class attribute needed. `@media` queries fold into per-breakpoint overrides (matched against the site breakpoints); other `@media`/`@supports`/`@container` round-trip as reusable conditions. Re-applying a selector MERGES onto the existing rule, so this both creates new styles and edits existing ones (e.g. `.hero a:hover { color: var(--primary) }` to restyle an existing descendant rule). Reference design tokens — `var(--primary)`, `var(--text-l)`, `var(--space-m)` — not raw hex/px. A reusable class is just a bare `.name` selector (a CSS identifier, no spaces). Success data: `{ cssRulesCreated, cssRulesUpdated }`.',
  inputSchema: ApplyCssInputSchema,
}

const assignClassTool: AiTool = {
  name: 'site_assign_class',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    "Attach an existing CSS class to a node. `classId` accepts id or name.",
  inputSchema: AssignClassInputSchema,
}

const removeClassTool: AiTool = {
  name: 'site_remove_class',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Detach a class from a node (the class itself is not deleted). `classId` accepts id or name.',
  inputSchema: RemoveClassInputSchema,
}

// ---------------------------------------------------------------------------
// Code asset tools — scripts and user stylesheets in site.files + site.runtime
// ---------------------------------------------------------------------------

const listCodeAssetsTool: AiTool = {
  name: 'site_list_code_assets',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: ['site.read'],
  description:
    'List user-authored runtime code assets stored in the site file layer. Optional `type` filters to scripts or styles. Returns file ids, paths, content hashes, size metadata, and current runtime config. Use before site_read_code_asset / site_patch_code_asset when modifying existing scripts or stylesheets.',
  inputSchema: ListCodeAssetsInputSchema,
}

const readCodeAssetTool: AiTool = {
  name: 'site_read_code_asset',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: ['site.read'],
  description:
    'Read one script or stylesheet by fileId or path. Returns the exact content slice, full-file SHA-256 hash, runtime config, and pageInfo for pagination. If pageInfo.nextPart is not null, call site_read_code_asset again with the same asset and part.',
  inputSchema: ReadCodeAssetInputSchema,
}

const writeCodeAssetTool: AiTool = {
  name: 'site_write_code_asset',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Create or replace a runtime script/style file in site.files and attach normalized site.runtime config. Use `type:"script"` for behavior such as theme toggles, menus, tabs, analytics hooks, and DOM-ready interactions; use `type:"style"` for global user stylesheets that should load as files. `path` is a safe site-relative path such as src/scripts/theme-toggle.js or src/styles/theme.css. `runtime` is optional and merges with existing/default config.',
  inputSchema: WriteCodeAssetInputSchema,
}

const patchCodeAssetTool: AiTool = {
  name: 'site_patch_code_asset',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Patch an existing script or stylesheet by exact text replacement. Requires the latest `expectedHash` from site_read_code_asset/site_list_code_assets to prevent stale edits. Each replacement must match exactly; if oldText occurs multiple times, either make oldText more specific or set replaceAll:true.',
  inputSchema: PatchCodeAssetInputSchema,
}

const inspectCodeRuntimeTool: AiTool = {
  name: 'site_inspect_code_runtime',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: ['site.read'],
  description:
    'Inspect which runtime scripts and user stylesheets apply to the current page/template, or to a supplied page/template document ref. Returns each asset path, enabled state, scope applicability, priority, and script placement/timing. Use after site_write_code_asset to confirm a script/style is targeted correctly.',
  inputSchema: InspectCodeRuntimeInputSchema,
}

// ---------------------------------------------------------------------------
// Page-level write tools
// ---------------------------------------------------------------------------

const addPageTool: AiTool = {
  name: 'site_add_page',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Add an EMPTY page and make it the active page. `slug` defaults to a slugified title and is auto-uniqued (a repeat add becomes `-2`, `-3`) — so never call site_add_page twice for the same page. Success data: `pageId` and `rootNodeId`. To build into the new page, pass `rootNodeId` as site_insert_html\'s `parentId` — a pageId is NOT a node id. The page is already active, so just start inserting; no need to site_read_document/site_list_documents first. For copying an existing page use site_duplicate_page.',
  inputSchema: AddPageInputSchema,
}

const deletePageTool: AiTool = {
  name: 'site_delete_page',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Permanently delete a page. Fails if it would leave the site with zero pages.',
  inputSchema: DeletePageInputSchema,
}

const renamePageTool: AiTool = {
  name: 'site_rename_page',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    "Change a page's title and/or slug. `slug=\"index\"` makes this page the homepage. Omit slug to keep it.",
  inputSchema: RenamePageInputSchema,
}

const duplicatePageTool: AiTool = {
  name: 'site_duplicate_page',
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
  name: 'site_set_page_template',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Turn a page INTO a template (or update an existing template\'s target/priority). `target` is `{kind:"everywhere"}` for a site-wide layout that wraps every page+entry, `{kind:"postTypes", tableSlugs:[…]}` to wrap entries of those post types (slugs from site_list_post_types), or `{kind:"notFound"}` for the page served on public 404s (status 404, wrapped by the everywhere layout; needs no outlet). `priority` (default 100) breaks ties when several templates match at the same breadth level — higher wins. An everywhere/postTypes template needs exactly one `<instatic-outlet>` (insert it via site_insert_html) marking where matched content flows; a wrapper template with no outlet simply doesn\'t apply. Pass a real page id from the suffix / site_list_documents.',
  inputSchema: SetPageTemplateInputSchema,
}

const clearPageTemplateTool: AiTool = {
  name: 'site_clear_page_template',
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
  name: 'site_set_color_tokens',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Create or update framework COLOR tokens — the source of truth for color. Each `{ slug, lightValue }` becomes `var(--<slug>)` plus generated utility classes (text-/bg-/border-) and shade/tint variants. Create-or-update is keyed by `slug`: an existing slug is patched, a new one is created. `lightValue` is any CSS color (hex/rgb/hsl); omit `darkValue` to auto-generate it. Establish color tokens before styling and reference them as `var(--<slug>)` instead of raw hex.',
  inputSchema: SetColorTokensInputSchema,
}

const setFontTokensTool: AiTool = {
  name: 'site_set_font_tokens',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Create or update FONT tokens — named typefaces referenced as `var(--<variable>)`. Pass `googleFamily` (e.g. "Inter") to install a new Google web font (downloads the files, then binds the token to it); `variants` defaults to ["400","700"] and `subsets` to ["latin"]. Pass `familyId` to reference an already-installed family. Pass neither for a fallback-only/system token. Create-or-update is keyed by `variable` (defaults from `name`). `googleFamily` and `familyId` are mutually exclusive.',
  inputSchema: SetFontTokensInputSchema,
}

const setTypeScaleTool: AiTool = {
  name: 'site_set_type_scale',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Configure the TYPOGRAPHY scale — the fluid type ramp generating `--text-*` variables (default prefix "text"). A scale is a config: `min`/`max` give the base `fontSize` (px) and `scaleRatio` at the small/large screen anchors; `steps` is the comma-separated step list (e.g. "xs,s,m,l,xl,2xl,3xl,4xl") and `baseScaleIndex` picks which step equals the base size. Creates the group if none exists, else updates it (target a specific one with `groupId`). Reference sizes as `var(--text-l)` rather than raw px.',
  inputSchema: SetTypeScaleInputSchema,
}

const setSpacingScaleTool: AiTool = {
  name: 'site_set_spacing_scale',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Configure the SPACING scale — the fluid spacing ramp generating `--space-*` variables (default prefix "space"). Same shape as site_set_type_scale but `min`/`max` carry `size` (px) instead of `fontSize`; `steps` defaults to an 11-step scale and `baseScaleIndex` to 5 ("m"). Creates the group if none exists, else updates it. Reference gaps/padding as `var(--space-l)` rather than raw px.',
  inputSchema: SetSpacingScaleInputSchema,
}

// ---------------------------------------------------------------------------
// site_render_snapshot — browser-bridged, returns a special payload
// ---------------------------------------------------------------------------

const renderSnapshotTool: AiTool = {
  name: 'site_render_snapshot',
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
  readDocumentTool,
  openDocumentTool,
  replaceNodeHtmlTool,
  deleteNodeTool,
  updateNodePropsTool,
  moveNodeTool,
  renameNodeTool,
  duplicateNodeTool,
  applyCssTool,
  assignClassTool,
  removeClassTool,
  listCodeAssetsTool,
  readCodeAssetTool,
  writeCodeAssetTool,
  patchCodeAssetTool,
  inspectCodeRuntimeTool,
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
