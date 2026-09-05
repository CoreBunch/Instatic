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
  ApplyCssExecutionInputSchema,
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
  type GetNodeHtmlInput,
  type ReadDocumentInput,
  type OpenDocumentInput,
  type DeleteNodeInput,
  type UpdateNodePropsInput,
  type MoveNodeInput,
  type RenameNodeInput,
  type DuplicateNodeInput,
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
import type { PageTemplateConfig } from '@core/page-tree'
import { renderNode, type RenderConfig, type RenderAccumulators } from '@core/publisher'
import { getAgentStoreApi } from './storeRef'
import { whenCollabWritable } from '@site/store/slices/site/collabWriteGate'
import { AUTO_NAVIGATE_TOOLS, SITE_MUTATION_TOOLS } from './toolClassification'
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
import { runRenderSnapshotAtBreakpoint } from './renderSnapshotAtBreakpoint'
import { runApplyCss } from './cssTools'
import { runInsertHtml, runReplaceNodeHtml } from './htmlTools'
import {
  activeRenderPage,
  findNodeInActiveDoc,
  focusNodeDocument,
  nodeNotInActiveDocError,
  runOpenDocument,
  runReadDocument,
} from './documentTools'
import { getErrorMessage } from '@core/utils/errorMessage'

// Live access to the editor store. Routed through `./storeRef` so this module
// has no static import edge back into `editor-store/store.ts`.
const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

// ---------------------------------------------------------------------------
// Tool input validation
//
// The provider-facing and execution input schemas have one source in `@core/ai`
// (`src/core/ai/toolSchemas.ts`). The executor imports them and validates each
// `toolRequest` payload here with `parseValue` — defence-in-depth at the store
// boundary (Constraint #272). Most tools use one schema for both layers.
//
// Two deliberate provider-boundary layers live here:
// - `site_render_snapshot` composes the server-set `captureScreenshot` flag
//   onto its model-facing schema.
// - `site_apply_css` advertises a flat provider-compatible object, then uses
//   `ApplyCssExecutionInputSchema` here for exact operation-specific fields.
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
    cspSources: new Map(),
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
    // A write refused by the collab sync gate never reaches the relay, so wait
    // for the gate to open rather than reporting a success the server will
    // never see. Sub-second in practice; the deadline exists so a genuinely
    // stuck socket surfaces as an error instead of hanging the tool call.
    if (SITE_MUTATION_TOOLS.has(toolName) && !(await whenCollabWritable())) {
      return aiToolError(
        'Editor is still syncing with the collaboration relay; the write was not applied. Retry shortly.',
      )
    }

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
      case 'site_apply_css': {
        const providerInput = parseValue(ApplyCssInputSchema, rawInput)
        return runApplyCss(parseValue(ApplyCssExecutionInputSchema, providerInput))
      }
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
        return await runRenderSnapshotAtBreakpoint({ ...parsed, breakpointId })
      }
      default:
        return aiToolError(`Unknown instatic tool: ${toolName}`)
    }
  } catch (err) {
    const message = getErrorMessage(err, String(err))
    return aiToolError(message)
  }
}
