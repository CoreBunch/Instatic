/**
 * The two HTML-payload tools, `site_insert_html` and `site_replace_node_html`.
 *
 * Both run the pipeline the paste-import modal uses (`importHtml`, then
 * `parseImportedStyleCss`, then `insertImportedNodes`) and report the same
 * things back: unresolved importer references, stripped `<script>` / `on*`
 * handlers, and the head-only elements the parser kept out of the body (#490).
 */
import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  type InsertHtmlInput,
  type ReplaceNodeHtmlInput,
} from '@core/ai'
import type { EditorStore } from '@site/store/types'
import { importHtml, type ImportResult } from '@core/htmlImport'
import { getAgentStoreApi } from './storeRef'
import { parseImportedStyleCss } from './cssTools'
import { activeDocumentNodes, findNodeInActiveDoc, nodeNotInActiveDocError } from './documentTools'

// Live access to the editor store, routed through `./storeRef` like the executor.
const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

// ---------------------------------------------------------------------------
// Import diagnostics shared by insertHtml / replaceNodeHtml
// ---------------------------------------------------------------------------

/**
 * Everything the importer dropped or ignored, as caller-facing sentences.
 * Reported on success as `warnings` and folded into the error when nothing
 * was importable, so a `<script>` inside otherwise valid markup no longer
 * vanishes silently and a head-only payload says which element it was (#490).
 */
function importNotices(result: ImportResult): string[] {
  const notices: string[] = []
  const { stripped, headOnly } = result
  if (stripped.scripts > 0) {
    notices.push(
      `Stripped ${stripped.scripts} <script> element${stripped.scripts === 1 ? '' : 's'}: scripts are not page nodes. `
      + 'Create runtime behaviour with site_write_code_asset({ type: "script", ... }) instead.',
    )
  }
  if (stripped.inlineHandlers > 0) {
    notices.push(
      `Stripped ${stripped.inlineHandlers} inline event handler attribute${stripped.inlineHandlers === 1 ? '' : 's'} (on*): `
      + 'bind behaviour from a code asset instead.',
    )
  }
  if (headOnly.length > 0) {
    notices.push(
      `Ignored ${headOnly.map((tag) => `<${tag}>`).join(', ')}: these belong in the document <head>, which the site generates `
      + 'from its settings (favicon, title, meta), so they cannot be inserted as page nodes.',
    )
  }
  return notices
}

function noImportableElementsError(result: ImportResult): AiToolOutput {
  return aiToolError(
    ['HTML contained no importable elements or style rules.', ...importNotices(result)].join(' '),
  )
}

/** Importer reference warnings plus the strip / head-only notices, or nothing. */
function importWarningsField(result: ImportResult): { warnings?: string[] } {
  const warnings = [...result.warnings.map((w) => w.message), ...importNotices(result)]
  return warnings.length > 0 ? { warnings } : {}
}

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
export function runInsertHtml(input: InsertHtmlInput): AiToolOutput {
  // (1) Parse and walk the HTML to produce a flat node fragment + any <style> CSS
  const imported = importHtml(input.html)
  const { nodes, rootIds, styleCss } = imported
  const { rules, conditions } = parseImportedStyleCss(styleCss)

  if (rootIds.length === 0) {
    // A <style>-only payload carries no elements but still carries authorable
    // CSS — reusable classes and ambient rules (`a:hover`, `.hero a`,
    // `::before`, …). Upsert them rather than discarding them. (The dedicated
    // `site_apply_css` tool is the canonical path for this; insertHtml stays forgiving
    // when a CSS-only payload arrives here.)
    if (rules.length > 0 || conditions.length > 0) {
      const result = getStoreState().applyCssRules(rules, conditions, 'merge')
      if (result.blockedSelectors.length > 0) {
        return aiToolError(
          `Framework-generated CSS selectors are locked: ${result.blockedSelectors.join(', ')}`,
        )
      }
      return aiToolOk({ cssRulesCreated: result.created, cssRulesUpdated: result.updated })
    }
    return noImportableElementsError(imported)
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

  // `insertedRootIds` are the ids the insert INTENDED to create. If none of
  // them is in the store afterwards the mutation was refused (collab gate,
  // offline transport), and reporting those ids would claim a subtree that
  // does not exist — the caller then builds on nodes the server never saw.
  if (created.length === 0) {
    return aiToolError(
      'Insert was refused before it reached the store, so nothing was created. '
      + 'The editor is usually still syncing; retry shortly.',
    )
  }

  // Report references the importer could not resolve and anything it dropped.
  // Without this an `<instatic-loop>` naming a source that does not exist
  // inserts cleanly, publishes an empty section, and passes every downstream
  // check — the caller only finds out by looking at the rendered page.
  return aiToolOk({
    nodeIds: insertedRootIds,
    created,
    ...importWarningsField(imported),
  })
}

/**
 * Replace the children of `nodeId` with an HTML snippet.
 *
 * The target node itself is preserved as the parent container. Its current
 * children (and their full subtrees) are deleted, then the imported HTML is
 * inserted in their place.
 */
export function runReplaceNodeHtml(input: ReplaceNodeHtmlInput): AiToolOutput {
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
  const imported = importHtml(input.html)
  const { nodes, rootIds, styleCss } = imported
  const { rules, conditions } = parseImportedStyleCss(styleCss)

  if (rootIds.length === 0) {
    // A <style>-only payload has nothing to replace the children WITH, so leave
    // the subtree intact and just upsert its rules — same forgiving behaviour
    // as insertHtml. Wiping children to insert nothing would be surprising.
    if (rules.length > 0 || conditions.length > 0) {
      const result = getStoreState().applyCssRules(rules, conditions, 'merge')
      if (result.blockedSelectors.length > 0) {
        return aiToolError(
          `Framework-generated CSS selectors are locked: ${result.blockedSelectors.join(', ')}`,
        )
      }
      return aiToolOk({ cssRulesCreated: result.created, cssRulesUpdated: result.updated })
    }
    return noImportableElementsError(imported)
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

  // Same unresolved-reference and stripped-construct report as insertHtml.
  return aiToolOk({
    nodeIds: insertedRootIds,
    ...importWarningsField(imported),
  })
}
