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

import { Type, type Static, parseValue } from '@core/utils/typeboxHelpers'
import {
  aiToolError,
  aiToolOk,
  type AiToolImage,
  type AiToolOutput,
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
  RenderSnapshotInputSchema,
  type InsertHtmlInput,
  type GetNodeHtmlInput,
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
import type { BaseNode, ConditionDef, Page, PageTemplateConfig } from '@core/page-tree'
import { renderNode, type RenderConfig, type RenderAccumulators } from '@core/publisher'
import { getAgentStoreApi } from './storeRef'
import { captureAgentRenderSnapshot, SnapshotNodeNotFoundError } from './renderEvidence'
import type { AgentRenderSnapshotPayload } from './types'
import {
  runSetColorTokens,
  runSetFontTokens,
  runSetTypeScale,
  runSetSpacingScale,
} from './tokenRunners'
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
// `render_snapshot` is the one divergence: the model-facing schema carries only
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
 * class identifier (assignClass/removeClass), without needing to remember the
 * generated nanoid from a previous applyCss call.
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
 * The node map of the ACTIVE document — the single tree every write tool
 * actually mutates (`mutateActiveTree`). Page mode → the active page's nodes;
 * VC mode → the active component's tree. Mirrors the active-document routing in
 * `mutateActiveTree`/`insertComponentRef` without importing the store module.
 */
function activeDocNodes(store: EditorStore): Record<string, BaseNode> | null {
  const site = store.site
  if (!site) return null
  const ad = store.activeDocument
  if (ad?.kind === 'visualComponent') {
    const vc = site.visualComponents?.find((v) => v.id === ad.vcId)
    return vc ? (vc.tree.nodes as Record<string, BaseNode>) : null
  }
  const pageId = ad?.kind === 'page' ? ad.pageId : store.activePageId
  const page = site.pages.find((p) => p.id === pageId)
  return page ? page.nodes : null
}

/** The active PAGE object (page mode only — null while editing a VC). */
function getActivePage(store: EditorStore): Page | null {
  const site = store.site
  if (!site) return null
  const ad = store.activeDocument
  if (ad?.kind === 'visualComponent') return null
  const pageId = ad?.kind === 'page' ? ad.pageId : store.activePageId
  return site.pages.find((p) => p.id === pageId) ?? null
}

/**
 * Resolve a node by ID **within the active document only** — never across other
 * pages, templates, or VCs. Write tools mutate the active tree, so resolving an
 * id that lives in a different document would silently target the wrong tree
 * (or fail with a misleading "does not accept children"). Returns the node when
 * it belongs to the active doc, else undefined.
 */
function findNodeInActiveDoc(store: EditorStore, nodeId: string): BaseNode | undefined {
  return activeDocNodes(store)?.[nodeId]
}

/**
 * When a node id is NOT in the active document, locate which OTHER document
 * owns it so the agent gets a precise, actionable error ("that node is in the
 * 'Global Layout' template — open it to edit") instead of "not found" or a
 * misleading mutation failure. Returns null when the id exists nowhere.
 */
function describeForeignNode(store: EditorStore, nodeId: string): string | null {
  const site = store.site
  if (!site) return null
  for (const page of site.pages) {
    if (page.nodes[nodeId]) {
      const what = page.template ? 'template' : 'page'
      return `the "${page.title}" ${what} (a different document)`
    }
  }
  for (const vc of site.visualComponents ?? []) {
    if (vc.tree.nodes[nodeId]) return `the "${vc.name}" component (a different document)`
  }
  return null
}

/**
 * Shared "node not found in the active doc" error: distinguishes a node that
 * lives in another document (actionable — switch docs) from one that exists
 * nowhere (a bad id).
 */
function nodeNotInActiveDocError(store: EditorStore, nodeId: string): AiToolOutput {
  const foreign = describeForeignNode(store, nodeId)
  return aiToolError(
    foreign
      ? `Node ${nodeId} lives in ${foreign} and could not be activated automatically.`
      : `Node not found: ${nodeId}`,
  )
}

/**
 * Ensure the document that owns `nodeId` is the ACTIVE one, navigating the
 * canvas to it when needed. Write tools mutate the active tree, so when the
 * agent targets a node in another page/template/VC we switch to that document
 * first — the edit then lands in the correct tree AND the user watches it
 * happen, instead of the tool silently no-op'ing on the wrong tree. No-op when
 * the node is already active or exists nowhere.
 */
function focusNodeDocument(store: EditorStore, nodeId: string): void {
  if (activeDocNodes(store)?.[nodeId]) return
  const site = store.site
  if (!site) return
  const ownerPage = site.pages.find((p) => p.nodes[nodeId])
  if (ownerPage) {
    store.openPageInCanvas(ownerPage.id)
    return
  }
  const ownerVc = site.visualComponents?.find((vc) => vc.tree.nodes[nodeId])
  if (ownerVc) {
    store.setActiveDocument({ kind: 'visualComponent', vcId: ownerVc.id })
  }
}

/**
 * Tools that target an existing node (by `nodeId`/`parentId`) and should pull
 * the canvas to that node's document before running. Excludes catalog/page/
 * token tools (no node target) and `render_snapshot` (captures the live DOM, so
 * a node outside the mounted canvas is genuinely uncapturable, not navigable).
 */
const AUTO_NAVIGATE_TOOLS = new Set<string>([
  'insertHtml',
  'getNodeHtml',
  'replaceNodeHtml',
  'deleteNode',
  'updateNodeProps',
  'moveNode',
  'renameNode',
  'duplicateNode',
  'assignClass',
  'removeClass',
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
  const { nodes, rootIds, styleCss } = importHtml(input.html)
  const { rules, conditions } = parseImportedStyleCss(styleCss)

  if (rootIds.length === 0) {
    // A <style>-only payload carries no elements but still carries authorable
    // CSS — reusable classes and ambient rules (`a:hover`, `.hero a`,
    // `::before`, …). Upsert them rather than discarding them. (The dedicated
    // `applyCss` tool is the canonical path for this; insertHtml stays forgiving
    // when a CSS-only payload arrives here.)
    if (rules.length > 0 || conditions.length > 0) {
      const { created, updated } = getStoreState().upsertCssRules(rules, conditions)
      return aiToolOk({ cssRulesCreated: created, cssRulesUpdated: updated })
    }
    return aiToolError('HTML contained no importable elements or style rules.')
  }

  // (2) Insert via the store action — same path as the paste import modal
  const insertedRootIds = getStoreState().insertImportedNodes(
    input.parentId,
    { nodes, rootIds },
    { index: input.index, styleRules: rules, conditions },
  )
  if (insertedRootIds.length === 0) {
    return aiToolError(`Parent node not found or does not accept children: ${input.parentId}`)
  }

  return aiToolOk({ nodeIds: insertedRootIds })
}

/**
 * Render the subtree at `nodeId` to HTML using the publisher's renderNode.
 * Read-only — no store mutation.
 */
function runGetNodeHtml(input: GetNodeHtmlInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')

  // Scope to the ACTIVE page only — never resolve a node from a different page
  // or template. read_page already exposes only the active page's nodes, so an
  // id from elsewhere is either stale or a wrapper/outlet-preview node the agent
  // can't edit from here.
  const activePage = getActivePage(store)
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
  const { nodes, rootIds, styleCss } = importHtml(input.html)
  const { rules, conditions } = parseImportedStyleCss(styleCss)

  if (rootIds.length === 0) {
    // A <style>-only payload has nothing to replace the children WITH, so leave
    // the subtree intact and just upsert its rules — same forgiving behaviour
    // as insertHtml. Wiping children to insert nothing would be surprising.
    if (rules.length > 0 || conditions.length > 0) {
      const { created, updated } = getStoreState().upsertCssRules(rules, conditions)
      return aiToolOk({ cssRulesCreated: created, cssRulesUpdated: updated })
    }
    return aiToolError('HTML contained no importable elements or style rules.')
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
          `\`breakpointOverridable: true\`. For per-breakpoint *visual* variation use applyCss with an ` +
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

async function runRenderSnapshot(
  input: Static<typeof renderSnapshotSchema>,
): Promise<AiToolOutput> {
  // Default true so a direct (non-server) invocation still works; the AI loop
  // always sets this explicitly from the model's vision capability.
  const captureScreenshot = input.captureScreenshot ?? true
  let snapshot: AgentRenderSnapshotPayload | null
  try {
    snapshot = await captureAgentRenderSnapshot({
      breakpointId: input.breakpointId,
      nodeId: input.nodeId,
      captureScreenshot,
    })
  } catch (err) {
    if (err instanceof SnapshotNodeNotFoundError) return aiToolError(err.message)
    throw err
  }
  if (!snapshot) {
    return aiToolError('No canvas frame found for the requested breakpoint.')
  }

  // The PNG travels through the dedicated image channel (a native image block on
  // vision providers) — NEVER inlined into `data` as base64 JSON text, which is
  // what blew a single snapshot past a million tokens. `data` keeps the layout
  // report plus a compact screenshot descriptor (status + dimensions only).
  const { screenshot, ...rest } = snapshot
  const images: AiToolImage[] = []
  if (screenshot.status === 'ok' && screenshot.data && screenshot.mimeType) {
    images.push({ mimeType: screenshot.mimeType, data: screenshot.data })
  }
  const screenshotMeta = {
    status: screenshot.status,
    ...(screenshot.width != null ? { width: screenshot.width } : {}),
    ...(screenshot.height != null ? { height: screenshot.height } : {}),
    ...(screenshot.error ? { error: screenshot.error } : {}),
  }

  return aiToolOk({ ...rest, screenshot: screenshotMeta }, images)
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
      case 'insertHtml':
        return runInsertHtml(parseValue(InsertHtmlInputSchema, rawInput))
      case 'getNodeHtml':
        return runGetNodeHtml(parseValue(GetNodeHtmlInputSchema, rawInput))
      case 'replaceNodeHtml':
        return runReplaceNodeHtml(parseValue(ReplaceNodeHtmlInputSchema, rawInput))
      case 'deleteNode':
        return runDeleteNode(parseValue(DeleteNodeInputSchema, rawInput))
      case 'updateNodeProps':
        return runUpdateNodeProps(parseValue(UpdateNodePropsInputSchema, rawInput))
      case 'moveNode':
        return runMoveNode(parseValue(MoveNodeInputSchema, rawInput))
      case 'renameNode':
        return runRenameNode(parseValue(RenameNodeInputSchema, rawInput))
      case 'applyCss':
        return runApplyCss(parseValue(ApplyCssInputSchema, rawInput))
      case 'assignClass':
        return runAssignClass(parseValue(AssignClassInputSchema, rawInput))
      case 'removeClass':
        return runRemoveClass(parseValue(RemoveClassInputSchema, rawInput))
      case 'addPage':
        return runAddPage(parseValue(AddPageInputSchema, rawInput))
      case 'deletePage':
        return runDeletePage(parseValue(DeletePageInputSchema, rawInput))
      case 'renamePage':
        return runRenamePage(parseValue(RenamePageInputSchema, rawInput))
      case 'duplicatePage':
        return runDuplicatePage(parseValue(DuplicatePageInputSchema, rawInput))
      case 'setPageTemplate':
        return runSetPageTemplate(parseValue(SetPageTemplateInputSchema, rawInput))
      case 'clearPageTemplate':
        return runClearPageTemplate(parseValue(ClearPageTemplateInputSchema, rawInput))
      case 'duplicateNode':
        return runDuplicateNode(parseValue(DuplicateNodeInputSchema, rawInput))
      case 'set_color_tokens':
        return runSetColorTokens(rawInput)
      case 'set_font_tokens':
        return await runSetFontTokens(rawInput)
      case 'set_type_scale':
        return runSetTypeScale(rawInput)
      case 'set_spacing_scale':
        return runSetSpacingScale(rawInput)
      case 'render_snapshot':
        return await runRenderSnapshot(parseValue(renderSnapshotSchema, rawInput))
      default:
        return aiToolError(`Unknown instatic tool: ${toolName}`)
    }
  } catch (err) {
    const message = getErrorMessage(err, String(err))
    return aiToolError(message)
  }
}
