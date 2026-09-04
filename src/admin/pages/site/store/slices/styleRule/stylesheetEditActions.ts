/**
 * styleRule slice — `applyStylesheetEdit`, the God Mode CSS panel's write
 * path. One call applies a whole `StylesheetEdit` plan (from
 * `@core/cssProjection`'s `planStylesheetEdit`) as ONE undoable mutation:
 * rule upserts by exact selector (replace semantics), cleared class blocks,
 * deleted ambient blocks, and the selected node's inline styles. Each
 * debounced panel flush therefore lands as exactly one tree-undo step.
 */

import type { PageNode, StyleRule } from '@core/page-tree'
import { isGeneratedClassLocked } from '@core/page-tree'
import type { EditorStore } from '@site/store/types'
import type { Draft } from 'mutative'
import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice, StylesheetEditResult } from './types'
import { forgetDeletedRuleRefs } from './helpers'
import {
  consolidateIncomingRules,
  payloadEqual,
  payloadFromRule,
  rulesBySelector,
  upsertRulesIntoSite,
  writePayload,
} from './rulePayload'

type StylesheetEditActions = Pick<StyleRuleSlice, 'applyStylesheetEdit'>

const EMPTY_PAYLOAD = { styles: {}, contextStyles: {} }

/** The node the CSS panel projects lives in the active canvas document. */
function findActiveTreeNode(state: Draft<EditorStore>, nodeId: string): PageNode | null {
  if (!state.site) return null
  const activeDocument = state.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    const vc = state.site.visualComponents.find((v) => v.id === activeDocument.vcId)
    return vc?.tree.nodes[nodeId] ?? null
  }
  const page = state.site.pages.find((p) => p.id === state.activePageId)
  return page?.nodes[nodeId] ?? null
}

function inlineBagsEqual(current: Record<string, unknown> | undefined, next: Record<string, unknown>): boolean {
  const currentEntries = Object.entries(current ?? {})
  if (currentEntries.length !== Object.keys(next).length) return false
  return currentEntries.every(([key, value]) => key in next && Object.is(next[key], value))
}

export function createStylesheetEditActions({ get, mutateSiteState }: SiteSliceHelpers): StylesheetEditActions {
  return {
    applyStylesheetEdit(edit) {
      const noop: StylesheetEditResult = {
        created: 0,
        updated: 0,
        cleared: 0,
        deleted: 0,
        inlineChanged: false,
        blockedSelectors: [],
      }
      const { site } = get()
      if (!site) return noop

      const incoming = consolidateIncomingRules(edit.rules)
      const existingBySelector = rulesBySelector(site.styleRules)
      const blockedSelectors = incoming
        .filter(({ selector }) => (existingBySelector.get(selector) ?? []).some(isGeneratedClassLocked))
        .map(({ selector }) => selector)
      const applicable = incoming.filter(({ selector }) => !blockedSelectors.includes(selector))
      const isEditable = (rule: StyleRule | undefined): rule is StyleRule =>
        rule !== undefined && !isGeneratedClassLocked(rule)

      const result: StylesheetEditResult = { ...noop, blockedSelectors }
      mutateSiteState((state, draft) => {
        const now = Date.now()
        const conditionsBefore = draft.conditions?.length ?? 0
        const upserted = upsertRulesIntoSite(draft, applicable, edit.conditions, 'replace', now)
        result.created = upserted.created
        result.updated = upserted.updated

        for (const classId of edit.clearedClassIds) {
          const rule = draft.styleRules[classId]
          if (!isEditable(rule) || payloadEqual(payloadFromRule(rule), EMPTY_PAYLOAD)) continue
          writePayload(rule, EMPTY_PAYLOAD)
          rule.updatedAt = now
          result.cleared++
        }

        const deleted = new Set<string>()
        for (const ambientId of edit.deletedAmbientIds) {
          if (!isEditable(draft.styleRules[ambientId])) continue
          delete draft.styleRules[ambientId]
          deleted.add(ambientId)
        }
        result.deleted = deleted.size
        if (deleted.size > 0) forgetDeletedRuleRefs(state, deleted)

        if (edit.inlineStyles) {
          const node = findActiveTreeNode(state, edit.inlineStyles.nodeId)
          if (node && !inlineBagsEqual(node.inlineStyles, edit.inlineStyles.styles)) {
            if (Object.keys(edit.inlineStyles.styles).length > 0) {
              node.inlineStyles = { ...edit.inlineStyles.styles }
            } else {
              delete node.inlineStyles
            }
            result.inlineChanged = true
          }
        }

        return (
          result.created > 0
          || result.updated > 0
          || result.cleared > 0
          || result.deleted > 0
          || result.inlineChanged
          || (draft.conditions?.length ?? 0) !== conditionsBefore
        )
      })

      return result
    },
  }
}
