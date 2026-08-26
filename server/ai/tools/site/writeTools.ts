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
 * (`src/core/ai/toolSchemas.ts`). This module imports each provider-facing
 * `*InputSchema`; the browser executor imports the same schemas for validation.
 * `site_apply_css` has one deliberate second layer: providers receive a flat
 * object because Anthropic rejects root schema composition, then the executor
 * validates the call against the exact `ApplyCssExecutionInputSchema` union.
 * Both CSS layers reuse the same field schemas in the shared leaf.
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
  CreateComponentInputSchema,
  InsertComponentInputSchema,
  SetComponentParamsInputSchema,
  BindComponentPropInputSchema,
  BindComponentVariantInputSchema,
} from '@core/ai'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'

// ---------------------------------------------------------------------------
// Capability requirements (ANY-OF) — mirror the editor's change-class model
// (structure / content / style — see server/writePolicy/siteDiff.ts and the
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
    'Insert semantic HTML as a subtree of editable nodes under an existing parent. Write structure as HTML (<section>, <h1>, <a>, <button>, <img>, <ul>, ...) and style it with CSS in the same call: put a <style> block in the HTML and/or class= attributes. Custom importer markers: <instatic-loop data-source-id="…" ...> creates a real Loop node (call site_list_loop_sources first for source/table ids and {currentEntry.*} tokens; never place the loop inside a <table>, <tbody> or <tr> — HTML parsing moves it out of the table and leaves its rows behind, publishing one blank row. Wrap the whole <table> in the loop, or use a list); <instatic-outlet data-tag="div"> creates a neutral template content outlet. On PAGE routes the outlet element is not rendered at all — the page content is spliced in at its position — so wrap the outlet in <main> yourself if pages should have a main landmark. data-tag only takes effect on ENTRY routes, where the outlet stays and wraps the entry body (use data-custom-tag for a safe custom element). The importer parses every rule — a bare `.foo {}` selector becomes a reusable Selectors-panel class bound to class="foo"; any other selector (`.hero a`, `a:hover`, `nav > li`) becomes an ambient rule. Inline style= attributes land on the node\'s inline styles. To author or edit CSS on its own — pseudo/hover/descendant selectors, or restyling existing rules — use the dedicated site_apply_css tool instead (site_insert_html is for inserting structure). Returns `nodeIds` (the inserted roots) and `created` — every inserted node as { id, moduleId, classes } — so you can target a nested node (e.g. the wrapper you just added) without re-reading the whole tree.',
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
    "Replace a node subtree's children with new HTML. The target node is preserved as the parent; its existing children are rebuilt from the HTML. Style with CSS exactly as in site_insert_html: a <style> block and/or class= attributes; bare `.foo` selectors become reusable classes, other selectors become ambient rules. Custom importer markers work here too: <instatic-loop data-source-id=\"…\" ...> creates a real Loop node and <instatic-outlet data-tag=\"div\"> creates a neutral template content outlet (omit data-tag only when the outlet should render as main). To author or edit CSS on its own (without rebuilding children), use the dedicated site_apply_css tool instead.",
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
    'Author, repair, or delete CSS rules. `operation:"merge"` plus real CSS creates missing selectors and patches only authored declarations/contexts; use it for normal additive edits. `operation:"replace"` makes each supplied selector\'s COMPLETE CSS payload authoritative, removing omitted base/context declarations while preserving rule identity, cascade order, and class assignments. `operation:"remove-properties"` removes named CSS properties from base and every context without disturbing other declarations. `operation:"delete"` removes whole rules by exact emitted selector and detaches deleted classes. Selector identity is exact: `.grad`, `.hero .grad`, and `.grad, .hero .grad` are different rules; copy the full selector from site_read_document before destructive operations. Bare `.foo` rules are reusable classes; descendant/pseudo/element/grouped selectors are ambient rules. `@media`/`@supports`/`@container`, vendor properties, custom properties, and `!important` round-trip. Reference design tokens rather than repeated literals. Success data uses `cssRulesCreated`, `cssRulesUpdated`, `cssRulesDeleted`, and/or `cssPropertiesRemoved`.',
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
    'Create or replace a runtime script/style file in site.files and attach normalized site.runtime config. Use `type:"script"` for behavior such as theme toggles, menus, tabs, analytics hooks, and DOM-ready interactions; use `type:"style"` for global user stylesheets that should load as files. `path` is a safe site-relative path such as src/scripts/theme-toggle.js or src/styles/theme.css. `runtime` is optional and merges with existing/default config. For module scripts that import npm packages, use bare package imports in `content` and declare them in `dependencies` (package name → semver/range) so they are added to the site dependency manifest; do not use npm CDN URLs for npm packages.',
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
    'Create or update FONT tokens — named typefaces referenced as `var(--<variable>)`. Pass `googleFamily` (e.g. "Inter") to install a new Google web font (downloads the files, then binds the token to it); `variants` defaults to ["400","700"] and `subsets` to ["latin"]. Pass `familyId` to reference an already-installed family. Pass neither for a fallback-only/system token. Create-or-update is keyed by `variable` (defaults from `name`). Prefer exactly one of `googleFamily` or `familyId`; if both are sent, `googleFamily` wins and the stale `familyId` is ignored.',
  inputSchema: SetFontTokensInputSchema,
}

const setTypeScaleTool: AiTool = {
  name: 'site_set_type_scale',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Configure the TYPOGRAPHY scale — the fluid type ramp generating `--text-*` variables (default prefix "text"). A scale is a config: `min`/`max` give the base `fontSize` (px) and `scaleRatio` at the small/large screen anchors; `steps` is the comma-separated step list (e.g. "xs,s,m,l,xl,2xl,3xl,4xl") and `baseScaleIndex` picks which step equals the base size. Creates the group if none exists, else updates it. Only pass `groupId` when you have a real existing group id; use `namingConvention:"text"` for the prefix. Reference sizes as `var(--text-l)` rather than raw px.',
  inputSchema: SetTypeScaleInputSchema,
}

const setSpacingScaleTool: AiTool = {
  name: 'site_set_spacing_scale',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STYLE_CAPS,
  description:
    'Configure the SPACING scale — the fluid spacing ramp generating `--space-*` variables (default prefix "space"). Same shape as site_set_type_scale but `min`/`max` carry `size` (px) instead of `fontSize`; `steps` defaults to an 11-step scale and `baseScaleIndex` to 5 ("m"). Creates the group if none exists, else updates it. Only pass `groupId` when you have a real existing group id; use `namingConvention:"space"` for the prefix. Reference gaps/padding as `var(--space-l)` rather than raw px.',
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
    "Inspect the rendered canvas. Returns viewport and node geometry, image-load status, overflow/visibility warnings, and key computed styles including color, background image/clip, and WebKit text-mask values. Those computed fields expose cascade failures such as a shorthand resetting `background-clip:text`; compare them with source CSS from site_read_document. When the provider supports image-bearing tool results, a screenshot is also attached. Pass any configured `breakpointId` to render a readiness-aware one-shot frame at that exact width, independent of collapsed/disabled frames or Live mode (defaults to active; unknown ids error). Pass `nodeId` to crop the document to that node while preserving its HTML/body/ancestor paint; omit it for the full page.",
  inputSchema: RenderSnapshotInputSchema,
}

// ---------------------------------------------------------------------------
// Visual Component tools
//
// A Visual Component is the reusable-structure primitive: one definition, many
// `base.visual-component-ref` instances. Styling is NOT parameterisable —
// params feed module props (text, href, image, colour VALUE), never classes or
// inline styles. For a base+variant look, put the base class inside the
// definition and add the variant class to each ref node with site_assign_class.
// ---------------------------------------------------------------------------

const createComponentTool: AiTool = {
  name: 'site_create_component',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Create a Visual Component — the reusable-structure primitive. Pass `fromNodeId` to componentize an EXISTING node: its whole subtree moves into the new component and the node is replaced in place by a reference to it (the same thing the editor\'s "Componentize" button does), so the page keeps rendering identically. Omit `fromNodeId` for an empty component you then fill with site_insert_html. `name` must be non-empty and unique across the site. The cloned content is always wrapped in a container root, so you can add siblings later even when componentizing a single Text or Button. Returns `componentId` and `rootNodeId` — pass that rootNodeId as site_insert_html\'s parentId to build inside the definition. Reuse it elsewhere with site_insert_component. Note that params are NOT created automatically: add them with site_set_component_params, then point node props at them with site_bind_component_prop.',
  inputSchema: CreateComponentInputSchema,
}

const insertComponentTool: AiTool = {
  name: 'site_insert_component',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Place an instance of an existing Visual Component under `parentId` in the active document, creating a `base.visual-component-ref` node. This is the only way to reuse a component — there is no HTML marker for it, so never try to write one into site_insert_html. `componentId` comes from site_create_component or site_list_documents (documents of type "visualComponent"). Slot params materialize their `base.slot-instance` children automatically, ready to receive content. Per-instance values go on the ref node: content via `propOverrides` (site_update_node_props), appearance via classes (site_assign_class) — a variant is a class on the instance, not a param. Errors instead of silently doing nothing when the parent is missing or the insertion would make a component contain itself.',
  inputSchema: InsertComponentInputSchema,
}

const setComponentParamsTool: AiTool = {
  name: 'site_set_component_params',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Declare a Visual Component\'s params — the typed inputs each instance can override. Send the params you want; each entry is matched to an existing param by `id` when given, otherwise by `name`, so repeat calls update rather than duplicate. Supplying `id` with a different `name` renames in place and keeps existing bindings and overrides intact. Types: string, number, boolean, url, enum, color, image, richText, slot (`slot` accepts nested content on each instance; `enum` renders as a dropdown and needs `enumOptions`). A param\'s type is FIXED after creation — to change it, drop the param and add it again. Omitted fields are left untouched; pass `removeMissing: true` to delete every param absent from the call, which also cleans up its bindings and per-instance overrides. Params carry VALUES into module props; they cannot switch classes or styles, so do not model visual variants as a param.',
  inputSchema: SetComponentParamsInputSchema,
}

const bindComponentPropTool: AiTool = {
  name: 'site_bind_component_prop',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    "Point a node's prop at a Visual Component param, so every instance renders its own value there — e.g. bind a Text node's `text` to a `label` param, or a Link's `href` to a `url` param. The node must live INSIDE the component definition; the canvas switches to its component automatically. Omit `paramId` to clear the binding (the prop keeps whatever value it last rendered, and a param nothing else references is garbage-collected). Bind content props only: `class` and `style` are not props, so appearance still comes from classes on the instance. Add the params first with site_set_component_params.",
  inputSchema: BindComponentPropInputSchema,
}

const bindComponentVariantTool: AiTool = {
  name: 'site_bind_component_variant',
  scope: 'site',
  execution: 'browser',
  requiredCapabilities: SITE_STRUCTURE_CAPS,
  description:
    'Make an enum param drive STYLING — the one thing a prop binding cannot do, because `class` is not a prop. Maps each value of `paramId` to a CSS class via `classByValue` (e.g. { primary: "btn-primary", ghost: "btn-ghost" }); at render the selected class is appended to this node\'s own classes, so the base class stays and the variant wins the cascade. The node must live INSIDE the component definition — usually its root. Editors then pick the variant from the param\'s dropdown on each instance, and restyling every button of that variant is one edit to the class. Classes are named by selector (`btn-ghost` or `.btn-ghost`) and must already exist — create them with site_apply_css first. A value you leave out of the map adds no class, which is how a "default"/"none" option works. Pass an empty `classByValue` to clear the binding. Declare the param with site_set_component_params (type "enum", one enumOption per key here) before calling this.',
  inputSchema: BindComponentVariantInputSchema,
}

// ---------------------------------------------------------------------------
// All write tools — convenient barrel for the registry
// ---------------------------------------------------------------------------

export const siteWriteTools: AiTool[] = [
  createComponentTool,
  insertComponentTool,
  setComponentParamsTool,
  bindComponentPropTool,
  bindComponentVariantTool,
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
