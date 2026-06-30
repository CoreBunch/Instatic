/**
 * Browser-side executor for instatic write tools.
 *
 * The AI runtime defines these browser-executed tools server-side, then emits a
 * `toolRequest` stream event so the browser can apply the mutation against the
 * live editor store. The browser then POSTs the canonical `AiToolOutput` back
 * to /admin/api/ai/tool-result and the driver loop continues.
 *
 * No batch semantics, no rollback. Each tool call is its own atomic mutation
 * — successful mutations push history entries normally so Cmd+Z reverts them.
 * Failed tool calls return an error result; Claude reads the error in the
 * next turn and decides how to recover.
 *
 * Constraint #272 — every input is validated with TypeBox before dispatch.
 * Constraint #283/#286 — no Anthropic SDK imports here.
 * Constraint #299 — richtext props are sanitized via DOMPurify before storage.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
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
  RenderSnapshotInputSchema,
  type InsertHtmlInput,
  type GetNodeHtmlInput,
  type ReadDocumentInput,
  type OpenDocumentInput,
  type ReplaceNodeHtmlInput,
  type DeleteNodeInput,
  type UpdateNodePropsInput,
  type MoveNodeInput,
  type RenameNodeInput,
  type DuplicateNodeInput,
  type ApplyCssInput,
  type AssignClassInput,
  type RemoveClassInput,
  type AddPageInput,
  type DeletePageInput,
  type RenamePageInput,
  type DuplicatePageInput,
  type SetPageTemplateInput,
  type ClearPageTemplateInput,
} from '@core/ai'
import type { EditorStore } from '@site/store/types'
import { registry } from '@core/module-engine'
import { sanitizeRichtext, isRichtextPropKey } from '@core/sanitize'
import { importHtml } from '@core/htmlImport'
import { cssToStyleRules } from '@core/siteImport'
import type { NewStyleRule } from '@core/siteImport'
import type { BaseNode, ConditionDef, PageTemplateConfig } from '@core/page-tree'
import { renderNode, type RenderConfig, type RenderAccumulators } from '@core/publisher'
import { getAgentStoreApi } from './storeRef'
import {
  runSetColorTokens,
  runSetFontTokens,
  runSetTypeScale,
  runSetSpacingScale,
} from './tokenRunners'
import {
  runInspectCodeRuntime,
  runListCodeAssets,
  runPatchCodeAsset,
  runReadCodeAsset,
  runWriteCodeAsset,
} from './codeAssetTools'
import { runRenderSnapshot } from './renderSnapshotTool'
import {
  activeDocumentNodes,
  activeRenderPage,
  describeDocumentId,
  describeForeignNode,
  focusNodeDocument,
  runOpenDocument,
  runReadDocument,
} from './documentTools'
import { getErrorMessage } from '@core/utils/errorMessage'

// Live access to the editor store. Routed through `./storeRef` so this module
// has no static import edge back into `editor-store/store.ts`.
const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

/**
 * Parse the CSS harvested from `<style>` blocks in an agent-supplied HTML
 * snippet into registry rules. Uses the live site's viewport contexts so any
 * matching `@media` folds into that viewport's contextStyles;
 * unmatched conditions round-trip as reusable site conditions. Returns empty
 * arrays for an empty/whitespace-only snippet.
 */
function parseImportedStyleCss(styleCss: string): {
  rules: NewStyleRule[]
  conditions: ConditionDef[]
} {
  if (!styleCss.trim()) return { rules: [], conditions: [] }
  const site = getStoreState().site
  const breakpoints = site
    ? site.breakpoints.map((b) => ({ id: b.id, width: b.width, mediaQuery: b.mediaQuery }))
    : []
  const { rules, conditions } = cssToStyleRules(styleCss, { breakpoints })
  return { rules, conditions }
}

// ---------------------------------------------------------------------------
// Tool input validation
//
// The per-tool input schemas are the single source of truth in `@core/ai`
// (`src/core/ai/toolSchemas.ts`) — the SAME schemas the server advertises as
// each tool's `inputSchema` in `server/ai/tools/site/writeTools.ts`. The
// executor imports them and re-validates each `toolRequest` payload here with
// `parseValue` — defence-in-depth at the store boundary (Constraint #272).
//
// `site_render_snapshot` is the one divergence: the model-facing schema carries only
// `breakpointId`/`nodeId`, so we compose the server-set `captureScreenshot`
// flag (chosen from the model's vision capability — non-vision models skip the
// expensive html-to-image capture) on top of the shared shape here.
// ---------------------------------------------------------------------------

const renderSnapshotSchema = Type.Composite([
  RenderSnapshotInputSchema,
  Type.Object({ captureScreenshot: Type.Optional(Type.Boolean()) }),
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a classId that may be either a real nanoid (checked first) or a
 * class name (fallback lookup). Returns the resolved ID string, or null if
 * no matching class is found.
 *
 * Lets Claude reference a class by name in tools that only accept a single
 * class identifier (site_assign_class/site_remove_class), without needing to remember the
 * generated nanoid from a previous site_apply_css call.
 */
function resolveClassId(
  store: EditorStore,
  classIdOrName: string,
): string | null {
  const classes = store.site?.styleRules
  if (!classes) return null
  if (classes[classIdOrName]) return classIdOrName
  // Filter (not find) so we can detect ambiguity. Uniqueness is enforced at
  // createClass time in the class slice; this guard is defence-in-depth.
  const matches = Object.values(classes).filter((c) => c.name === classIdOrName)
  if (matches.length > 1) return null
  return matches[0]?.id ?? null
}

function validateBreakpointId(
  store: EditorStore,
  breakpointId: string,
): string | null {
  const site = store.site
  if (!site) return `Breakpoint not found: ${breakpointId}`
  return site.breakpoints.some((breakpoint) => breakpoint.id === breakpointId)
    ? null
    : `Breakpoint not found: ${breakpointId}`
}

/**
 * Resolve a node by ID **within the active document only** — never across other
 * pages, templates, or VCs. Write tools mutate the active tree, so resolving an
 * id that lives in a different document would silently target the wrong tree
 * (or fail with a misleading "does not accept children"). Returns the node when
 * it belongs to the active doc, else undefined.
 */
function findNodeInActiveDoc(store: EditorStore, nodeId: string): BaseNode | undefined {
  return activeDocumentNodes(store)?.[nodeId]
}

/**
 * Shared "node not found in the active doc" error: distinguishes a node that
 * lives in another document (actionable — switch docs) from one that exists
 * nowhere (a bad id).
 */
function nodeNotInActiveDocError(store: EditorStore, nodeId: string): AiToolOutput {
  const documentIdError = describeDocumentId(store, nodeId)
  if (documentIdError) return aiToolError(documentIdError)
  const foreign = describeForeignNode(store, nodeId)
  return aiToolError(
    foreign
      ? `Node ${nodeId} lives in ${foreign} and could not be activated automatically.`
      : `Node not found: ${nodeId}`,
  )
}

/**
 * Tools that target an existing node (by `nodeId`/`parentId`) and should pull
 * the canvas to that node's document before running. Excludes catalog/page/
 * token tools (no node target) and `site_render_snapshot` (captures the live DOM, so
 * a node outside the mounted canvas is genuinely uncapturable, not navigable).
 */
const AUTO_NAVIGATE_TOOLS = new Set<string>([
  'site_insert_html',
  'site_get_node_html',
  'site_replace_node_html',
  'site_delete_node',
  'site_update_node_props',
  'site_move_node',
  'site_rename_node',
  'site_duplicate_node',
  'site_assign_class',
  'site_remove_class',
])

/** Pull the node/parent id a write tool targets out of its raw input bag. */
function targetNodeIdFromInput(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const bag = raw as Record<string, unknown>
  const id = bag.nodeId ?? bag.parentId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

// ---------------------------------------------------------------------------
// Per-tool implementations
// ---------------------------------------------------------------------------

/**
 * Insert an HTML snippet as page nodes under `parentId`.
 *
 * Pipeline (identical to the paste-import modal path):
 *   1. importHtml(input.html) — parse → strip unsafe → walkAndMap → fragment
 *      (+ inline `style="…"` on node.inlineStyles, + raw `<style>` CSS).
 *   2. parseImportedStyleCss — `<style>` CSS → registry rules + conditions.
 *      `cssToStyleRules` classifies each selector: a bare `.foo` becomes a
 *      reusable class, anything else (`.hero a`, `a:hover`, …) an ambient rule.
 *   3. insertImportedNodes(parentId, fragment, { index, styleRules, conditions })
 *      — nodes, <style> rules, and class-token binding in one undo step.
 */
function runInsertHtml(input: InsertHtmlInput): AiToolOutput {
  // (1) Parse and walk the HTML to produce a flat node fragment + any <style> CSS
  const { nodes, rootIds, styleCss, stripped } = importHtml(input.html)
  const { rules, conditions } = parseImportedStyleCss(styleCss)

  if (rootIds.length === 0) {
    // A <style>-only payload carries no elements but still carries authorable
    // CSS — reusable classes and ambient rules (`a:hover`, `.hero a`,
    // `::before`, …). Upsert them rather than discarding them. (The dedicated
    // `site_apply_css` tool is the canonical path for this; insertHtml stays forgiving
    // when a CSS-only payload arrives here.)
    if (rules.length > 0 || conditions.length > 0) {
      const { created, updated } = getStoreState().upsertCssRules(rules, conditions)
      return aiToolOk({ cssRulesCreated: created, cssRulesUpdated: updated })
    }
    const scriptHint = stripped.scripts > 0 || stripped.inlineHandlers > 0
      ? ' Scripts and inline event handlers are stripped from HTML imports; create runtime behavior with site_write_code_asset({ type:"script", ... }) instead.'
      : ''
    return aiToolError(`HTML contained no importable elements or style rules.${scriptHint}`)
  }

  // (2) Insert via the store action — same path as the paste import modal
  const store = getStoreState()
  const insertedRootIds = store.insertImportedNodes(
    input.parentId,
    { nodes, rootIds },
    { index: input.index, styleRules: rules, conditions },
  )
  if (insertedRootIds.length === 0) {
    return aiToolError(`Parent node not found or does not accept children: ${input.parentId}`)
  }

  // Return the full created subtree (id + module + class names) so the caller
  // can target nested nodes (e.g. the `.ist-shell` wrapper) without a separate
  // tree dump. `nodeIds` stays as the top-level roots for back-compat.
  // Read FRESH state after the insert — `store` above is the pre-insert
  // immutable snapshot, so its node map doesn't contain the new nodes (and its
  // styleRules lacks any classes insertImportedNodes auto-created).
  const postState = getStoreState()
  const nodeMap = activeDocumentNodes(postState) ?? {}
  const styleRules = postState.site?.styleRules ?? {}
  const created: Array<{ id: string; moduleId: string; classes: string[] }> = []
  const visit = (id: string): void => {
    const node = nodeMap[id]
    if (!node) return
    created.push({
      id,
      moduleId: node.moduleId,
      classes: (node.classIds ?? []).map((cid) => styleRules[cid]?.name ?? cid),
    })
    for (const childId of node.children) visit(childId)
  }
  for (const rootId of insertedRootIds) visit(rootId)

  return aiToolOk({ nodeIds: insertedRootIds, created })
}

/**
 * Render the subtree at `nodeId` to HTML using the publisher's renderNode.
 * Read-only — no store mutation.
 */
function runGetNodeHtml(input: GetNodeHtmlInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')

  // Scope to the active document only. Visual components are materialized as
  // virtual pages so site_get_node_html and site_read_document share publisher semantics.
  const activePage = activeRenderPage(store)
  if (!activePage?.nodes[input.nodeId]) {
    return nodeNotInActiveDocError(store, input.nodeId)
  }

  const config: RenderConfig = {
    page: activePage,
    site,
    registry,
    breakpointId: undefined,
    annotateNodeIds: true,
  }
  const acc: RenderAccumulators = {
    cssMap: new Map(),
    jsMap: new Map(),
    infiniteLoopIds: new Set(),
    holeNodeIds: new Set(),
  }

  const html = renderNode(input.nodeId, config, acc)
  return aiToolOk({ html })
}

function runReadDocumentTool(input: ReadDocumentInput): AiToolOutput {
  return runReadDocument(input, getStoreState())
}

function runOpenDocumentTool(input: OpenDocumentInput): AiToolOutput {
  return runOpenDocument(input, getStoreState())
}

/**
 * Replace the children of `nodeId` with an HTML snippet.
 *
 * The target node itself is preserved as the parent container. Its current
 * children (and their full subtrees) are deleted, then the imported HTML is
 * inserted in their place.
 */
function runReplaceNodeHtml(input: ReplaceNodeHtmlInput): AiToolOutput {
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')

  // Verify the target node exists IN THE ACTIVE DOCUMENT — the only tree this
  // mutation can touch. A node from another page/template/VC must not resolve.
  const targetNode = findNodeInActiveDoc(store, input.nodeId)
  if (!targetNode) {
    return nodeNotInActiveDocError(store, input.nodeId)
  }

  // Parse + validate the payload BEFORE mutating, so an empty / invalid payload
  // never wipes the node's existing children first and then errors out.
  const { nodes, rootIds, styleCss, stripped } = importHtml(input.html)
  const { rules, conditions } = parseImportedStyleCss(styleCss)

  if (rootIds.length === 0) {
    // A <style>-only payload has nothing to replace the children WITH, so leave
    // the subtree intact and just upsert its rules — same forgiving behaviour
    // as insertHtml. Wiping children to insert nothing would be surprising.
    if (rules.length > 0 || conditions.length > 0) {
      const { created, updated } = getStoreState().upsertCssRules(rules, conditions)
      return aiToolOk({ cssRulesCreated: created, cssRulesUpdated: updated })
    }
    const scriptHint = stripped.scripts > 0 || stripped.inlineHandlers > 0
      ? ' Scripts and inline event handlers are stripped from HTML imports; create runtime behavior with site_write_code_asset({ type:"script", ... }) instead.'
      : ''
    return aiToolError(`HTML contained no importable elements or style rules.${scriptHint}`)
  }

  // Delete existing children so the target node is empty before insertion.
  const existingChildren = [...(targetNode.children ?? [])]
  if (existingChildren.length > 0) {
    getStoreState().deleteNodes(existingChildren)
  }

  const insertedRootIds = getStoreState().insertImportedNodes(
    input.nodeId,
    { nodes, rootIds },
    { styleRules: rules, conditions },
  )
  if (insertedRootIds.length === 0) {
    return aiToolError(`Node does not accept children: ${input.nodeId}`)
  }

  return aiToolOk({ nodeIds: insertedRootIds })
}

function runDeleteNode(input: DeleteNodeInput): AiToolOutput {
  getStoreState().deleteNode(input.nodeId)
  return aiToolOk()
}

function runUpdateNodeProps(input: UpdateNodePropsInput): AiToolOutput {
  const store = getStoreState()
  const sanitizedPatch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.patch)) {
    sanitizedPatch[key] = isRichtextPropKey(key) && typeof value === 'string'
      ? sanitizeRichtext(value)
      : value
  }
  if (input.breakpointId) {
    const breakpointError = validateBreakpointId(store, input.breakpointId)
    if (breakpointError) return aiToolError(breakpointError)

    // Per-breakpoint writes are restricted to props the module schema marks
    // `breakpointOverridable: true`. Content props (text, tag, src, alt, …)
    // are single-value across all breakpoints because the published page is
    // one HTML document. Reject the call rather than silently dropping
    // non-overridable keys, so the agent gets a clear signal.
    const node = findNodeInActiveDoc(store, input.nodeId)
    if (!node) {
      return nodeNotInActiveDocError(store, input.nodeId)
    }
    const definition = registry.get(node.moduleId)
    if (!definition) {
      return aiToolError(`Unknown module on node: ${node.moduleId}`)
    }
    const nonOverridable = Object.keys(sanitizedPatch).filter(
      (key) => definition.schema[key]?.breakpointOverridable !== true,
    )
    if (nonOverridable.length > 0) {
      return aiToolError(
        `Cannot store breakpoint overrides for non-responsive prop(s) on ${node.moduleId}: ` +
          `${nonOverridable.join(', ')}. ` +
          `Module props are content (single value across breakpoints) unless the schema marks them ` +
          `\`breakpointOverridable: true\`. For per-breakpoint *visual* variation use site_apply_css with an ` +
          `\`@media\` query instead.`,
      )
    }
    store.setBreakpointOverride(input.nodeId, input.breakpointId, sanitizedPatch)
  } else {
    store.updateNodeProps(input.nodeId, sanitizedPatch)
  }
  return aiToolOk()
}

function runMoveNode(input: MoveNodeInput): AiToolOutput {
  getStoreState().moveNode(input.nodeId, input.newParentId, input.newIndex)
  return aiToolOk()
}

function runRenameNode(input: RenameNodeInput): AiToolOutput {
  getStoreState().renameNode(input.nodeId, input.label)
  return aiToolOk()
}

/**
 * Apply authored CSS text to the site's style registry.
 *
 * The single styling-by-CSS tool: parse the CSS with the SAME engine the HTML
 * importer uses (`cssToStyleRules` via `parseImportedStyleCss`), then UPSERT
 * every rule — a bare `.foo {}` selector creates/edits a reusable class, any
 * other selector (`.hero a`, `a:hover`, `nav > li`, `::before`) creates/edits
 * an ambient rule, and `@media` folds into per-breakpoint/condition overrides.
 * Re-applying an existing selector EDITS it; this is what `updateClassStyles`
 * could not do for descendant/pseudo selectors.
 */
function runApplyCss(input: ApplyCssInput): AiToolOutput {
  const { rules, conditions } = parseImportedStyleCss(input.css)
  if (rules.length === 0 && conditions.length === 0) {
    return aiToolError(
      'No CSS rules parsed. Provide CSS like ".hero { color: var(--primary) }" or ' +
        '"nav a:hover { text-decoration: underline }".',
    )
  }
  const { created, updated } = getStoreState().upsertCssRules(rules, conditions)
  return aiToolOk({ cssRulesCreated: created, cssRulesUpdated: updated })
}

function runAssignClass(input: AssignClassInput): AiToolOutput {
  const store = getStoreState()
  const classId = resolveClassId(store, input.classId)
  if (!classId) return aiToolError(`Class not found: ${input.classId}`)
  store.addNodeClass(input.nodeId, classId)
  return aiToolOk()
}

function runRemoveClass(input: RemoveClassInput): AiToolOutput {
  const store = getStoreState()
  const classId = resolveClassId(store, input.classId)
  if (!classId) return aiToolError(`Class not found: ${input.classId}`)
  store.removeNodeClass(input.nodeId, classId)
  return aiToolOk()
}

function runAddPage(input: AddPageInput): AiToolOutput {
  const page = getStoreState().addPage(input.title, input.slug)
  // rootNodeId is the parent to pass to insertHtml — a pageId is NOT a node id.
  // addPage also makes the new page active, so the insert targets it.
  return aiToolOk({ pageId: page.id, rootNodeId: page.rootNodeId })
}

function runDeletePage(input: DeletePageInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  if (!site.pages.some((p) => p.id === input.pageId)) {
    return aiToolError(`Page not found: ${input.pageId}`)
  }
  if (site.pages.length <= 1) {
    return aiToolError('Cannot delete the last page in a site.')
  }
  store.deletePage(input.pageId)
  return aiToolOk()
}

function runRenamePage(input: RenamePageInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  if (!site.pages.some((p) => p.id === input.pageId)) {
    return aiToolError(`Page not found: ${input.pageId}`)
  }
  store.renamePage(input.pageId, input.title, input.slug)
  return aiToolOk()
}

function runDuplicatePage(input: DuplicatePageInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  if (!site.pages.some((p) => p.id === input.pageId)) {
    return aiToolError(`Page not found: ${input.pageId}`)
  }
  const newPage = store.duplicatePage(input.pageId, input.title, input.slug)
  return aiToolOk({ pageId: newPage.id })
}

function runSetPageTemplate(input: SetPageTemplateInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  if (!site.pages.some((p) => p.id === input.pageId)) {
    return aiToolError(`Page not found: ${input.pageId}`)
  }
  const config: PageTemplateConfig = {
    enabled: true,
    target: input.target,
    priority: input.priority ?? 100,
  }
  store.convertPageToTemplate(input.pageId, config)
  return aiToolOk()
}

function runClearPageTemplate(input: ClearPageTemplateInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  const page = site.pages.find((p) => p.id === input.pageId)
  if (!page) return aiToolError(`Page not found: ${input.pageId}`)
  if (!page.template) {
    return aiToolError(`Page is not a template: ${input.pageId}`)
  }
  store.convertTemplateToPage(input.pageId)
  return aiToolOk()
}

function runDuplicateNode(input: DuplicateNodeInput): AiToolOutput {
  const store = getStoreState()
  const count = input.count ?? 1
  const newIds: string[] = []
  // Chain — clone the latest, not the source — so the resulting order is
  // [source, clone1, clone2, …, cloneN] rather than reverse-stacked.
  let lastId = input.nodeId
  for (let i = 0; i < count; i++) {
    const newId = store.duplicateNode(lastId)
    if (!newId) {
      return aiToolError(
        i === 0
          ? `Could not duplicate node: ${input.nodeId}`
          : `Duplicated ${i} of ${count} nodes before failing.`,
      )
    }
    newIds.push(newId)
    lastId = newId
  }
  return aiToolOk({ nodeId: newIds[0], nodeIds: newIds })
}

// ---------------------------------------------------------------------------
// Public dispatch — called by the agent slice when a toolRequest event arrives
// ---------------------------------------------------------------------------

/**
 * Apply a single instatic write tool against the editor store.
 *
 * The browser receives a `toolRequest` event from the server stream,
 * dispatches the tool here, and POSTs the canonical result back to
 * /admin/api/ai/tool-result so the driver loop can return it to the model.
 */
export async function executeAgentTool(
  toolName: string,
  rawInput: unknown,
): Promise<AiToolOutput> {
  try {
    // Auto-navigate: if a node-targeting tool references a node that lives in a
    // different document, switch the canvas to that document BEFORE running, so
    // the mutation lands in the right tree and stays visible to the user.
    if (AUTO_NAVIGATE_TOOLS.has(toolName)) {
      const targetId = targetNodeIdFromInput(rawInput)
      if (targetId) focusNodeDocument(getStoreState(), targetId)
    }

    switch (toolName) {
      case 'site_insert_html':
        return runInsertHtml(parseValue(InsertHtmlInputSchema, rawInput))
      case 'site_get_node_html':
        return runGetNodeHtml(parseValue(GetNodeHtmlInputSchema, rawInput))
      case 'site_read_document':
        return runReadDocumentTool(parseValue(ReadDocumentInputSchema, rawInput))
      case 'site_open_document':
        return runOpenDocumentTool(parseValue(OpenDocumentInputSchema, rawInput))
      case 'site_replace_node_html':
        return runReplaceNodeHtml(parseValue(ReplaceNodeHtmlInputSchema, rawInput))
      case 'site_delete_node':
        return runDeleteNode(parseValue(DeleteNodeInputSchema, rawInput))
      case 'site_update_node_props':
        return runUpdateNodeProps(parseValue(UpdateNodePropsInputSchema, rawInput))
      case 'site_move_node':
        return runMoveNode(parseValue(MoveNodeInputSchema, rawInput))
      case 'site_rename_node':
        return runRenameNode(parseValue(RenameNodeInputSchema, rawInput))
      case 'site_apply_css':
        return runApplyCss(parseValue(ApplyCssInputSchema, rawInput))
      case 'site_list_code_assets':
        return await runListCodeAssets(parseValue(ListCodeAssetsInputSchema, rawInput))
      case 'site_read_code_asset':
        return await runReadCodeAsset(parseValue(ReadCodeAssetInputSchema, rawInput))
      case 'site_write_code_asset':
        return await runWriteCodeAsset(parseValue(WriteCodeAssetInputSchema, rawInput))
      case 'site_patch_code_asset':
        return await runPatchCodeAsset(parseValue(PatchCodeAssetInputSchema, rawInput))
      case 'site_inspect_code_runtime':
        return runInspectCodeRuntime(parseValue(InspectCodeRuntimeInputSchema, rawInput))
      case 'site_assign_class':
        return runAssignClass(parseValue(AssignClassInputSchema, rawInput))
      case 'site_remove_class':
        return runRemoveClass(parseValue(RemoveClassInputSchema, rawInput))
      case 'site_add_page':
        return runAddPage(parseValue(AddPageInputSchema, rawInput))
      case 'site_delete_page':
        return runDeletePage(parseValue(DeletePageInputSchema, rawInput))
      case 'site_rename_page':
        return runRenamePage(parseValue(RenamePageInputSchema, rawInput))
      case 'site_duplicate_page':
        return runDuplicatePage(parseValue(DuplicatePageInputSchema, rawInput))
      case 'site_set_page_template':
        return runSetPageTemplate(parseValue(SetPageTemplateInputSchema, rawInput))
      case 'site_clear_page_template':
        return runClearPageTemplate(parseValue(ClearPageTemplateInputSchema, rawInput))
      case 'site_duplicate_node':
        return runDuplicateNode(parseValue(DuplicateNodeInputSchema, rawInput))
      case 'site_set_color_tokens':
        return runSetColorTokens(rawInput)
      case 'site_set_font_tokens':
        return await runSetFontTokens(rawInput)
      case 'site_set_type_scale':
        return runSetTypeScale(rawInput)
      case 'site_set_spacing_scale':
        return runSetSpacingScale(rawInput)
      case 'site_render_snapshot': {
        const parsed = parseValue(renderSnapshotSchema, rawInput)
        // Default to the breakpoint the user is actually viewing, not the first
        // frame in the DOM (which is mobile in a mobile-first canvas layout).
        const breakpointId = parsed.breakpointId ?? getStoreState().activeBreakpointId
        return await runRenderSnapshot({ ...parsed, breakpointId })
      }
      default:
        return aiToolError(`Unknown instatic tool: ${toolName}`)
    }
  } catch (err) {
    const message = getErrorMessage(err, String(err))
    return aiToolError(message)
  }
}
