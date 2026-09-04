/**
 * styleRule slice — rule payload algebra shared by the bulk CSS writers
 * (`applyCssRules`, `applyStylesheetEdit`): clone/merge/compare a rule's
 * declaration layers, consolidate authored duplicates, index the registry by
 * emitted selector, and upsert parsed rules into a site draft.
 */

import { nanoid } from 'nanoid'
import type { ConditionDef, SiteDocument, StyleRule } from '@core/page-tree'
import { styleRuleSelector } from '@core/page-tree'
import type { NewStyleRule } from '@core/siteImport'

export type PriorityBag = Record<string, 'important'>

export interface RulePayload {
  styles: Record<string, unknown>
  contextStyles: Record<string, Record<string, unknown>>
  stylePriorities?: PriorityBag
  contextStylePriorities?: Record<string, PriorityBag>
  rawCss?: string
}


function clonePriorityBag(priorities: PriorityBag | undefined): PriorityBag | undefined {
  if (!priorities || Object.keys(priorities).length === 0) return undefined
  return { ...priorities }
}

function cloneContextStyles(
  contexts: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(contexts ?? {}).map(([contextId, styles]) => [contextId, { ...styles }]),
  )
}

function cloneContextPriorities(
  contexts: Record<string, PriorityBag> | undefined,
): Record<string, PriorityBag> | undefined {
  if (!contexts) return undefined
  const cloned = Object.fromEntries(
    Object.entries(contexts)
      .filter(([, priorities]) => Object.keys(priorities).length > 0)
      .map(([contextId, priorities]) => [contextId, { ...priorities }]),
  )
  return Object.keys(cloned).length > 0 ? cloned : undefined
}

export function payloadFromRule(rule: StyleRule | NewStyleRule): RulePayload {
  return {
    styles: { ...rule.styles },
    contextStyles: cloneContextStyles(rule.contextStyles),
    stylePriorities: clonePriorityBag(rule.stylePriorities),
    contextStylePriorities: cloneContextPriorities(rule.contextStylePriorities),
    ...(rule.rawCss !== undefined ? { rawCss: rule.rawCss } : {}),
  }
}

function orderedBagEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index]
    return rightEntry?.[0] === key && Object.is(rightEntry[1], value)
  })
}

function priorityBagEqual(left: PriorityBag | undefined, right: PriorityBag | undefined): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value]) => right?.[key] === value)
}

function contextStylesEqual(
  left: Record<string, Record<string, unknown>>,
  right: Record<string, Record<string, unknown>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((contextId) => {
    const rightBag = right[contextId]
    return rightBag !== undefined && orderedBagEqual(left[contextId], rightBag)
  })
}

function contextPrioritiesEqual(
  left: Record<string, PriorityBag> | undefined,
  right: Record<string, PriorityBag> | undefined,
): boolean {
  const leftContexts = left ?? {}
  const rightContexts = right ?? {}
  const leftKeys = Object.keys(leftContexts)
  const rightKeys = Object.keys(rightContexts)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((contextId) => priorityBagEqual(leftContexts[contextId], rightContexts[contextId]))
}

export function payloadEqual(left: RulePayload, right: RulePayload): boolean {
  return orderedBagEqual(left.styles, right.styles)
    && contextStylesEqual(left.contextStyles, right.contextStyles)
    && priorityBagEqual(left.stylePriorities, right.stylePriorities)
    && contextPrioritiesEqual(left.contextStylePriorities, right.contextStylePriorities)
    && Object.is(left.rawCss, right.rawCss)
}

/**
 * Merge one declaration layer while moving every touched declaration to the
 * end in the incoming authored order. Object.assign keeps an existing key in
 * its old position, which can leave a longhand before a later shorthand and
 * make an apparently successful CSS repair lose in the emitted rule.
 */
function mergeLayer(
  current: Record<string, unknown>,
  currentPriorities: PriorityBag | undefined,
  patch: Record<string, unknown>,
  patchPriorities: PriorityBag | undefined,
  respectExistingImportant: boolean,
): { styles: Record<string, unknown>; priorities?: PriorityBag } {
  const acceptedPatchKeys = new Set<string>()
  for (const key of Object.keys(patch)) {
    if (
      respectExistingImportant
      && currentPriorities?.[key] === 'important'
      && patchPriorities?.[key] !== 'important'
    ) {
      continue
    }
    acceptedPatchKeys.add(key)
  }

  const styles: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(current)) {
    if (!acceptedPatchKeys.has(key)) styles[key] = value
  }
  for (const [key, value] of Object.entries(patch)) {
    if (acceptedPatchKeys.has(key)) styles[key] = value
  }

  const priorities: PriorityBag = {}
  for (const [key, priority] of Object.entries(currentPriorities ?? {})) {
    if (!acceptedPatchKeys.has(key)) priorities[key] = priority
  }
  for (const key of acceptedPatchKeys) {
    if (patchPriorities?.[key] === 'important') priorities[key] = 'important'
  }

  return {
    styles,
    ...(Object.keys(priorities).length > 0 ? { priorities } : {}),
  }
}

export function mergePayload(
  current: RulePayload,
  patch: RulePayload,
  respectExistingImportant: boolean,
): RulePayload {
  const base = mergeLayer(
    current.styles,
    current.stylePriorities,
    patch.styles,
    patch.stylePriorities,
    respectExistingImportant,
  )
  const contextStyles = cloneContextStyles(current.contextStyles)
  const contextStylePriorities = cloneContextPriorities(current.contextStylePriorities) ?? {}

  for (const [contextId, patchStyles] of Object.entries(patch.contextStyles)) {
    const merged = mergeLayer(
      contextStyles[contextId] ?? {},
      contextStylePriorities[contextId],
      patchStyles,
      patch.contextStylePriorities?.[contextId],
      respectExistingImportant,
    )
    contextStyles[contextId] = merged.styles
    if (merged.priorities) contextStylePriorities[contextId] = merged.priorities
    else delete contextStylePriorities[contextId]
  }

  return {
    styles: base.styles,
    contextStyles,
    ...(base.priorities ? { stylePriorities: base.priorities } : {}),
    ...(Object.keys(contextStylePriorities).length > 0 ? { contextStylePriorities } : {}),
    ...(patch.rawCss !== undefined
      ? { rawCss: patch.rawCss }
      : current.rawCss !== undefined
        ? { rawCss: current.rawCss }
        : {}),
  }
}

export function writePayload(target: StyleRule, payload: RulePayload): void {
  target.styles = payload.styles
  target.contextStyles = payload.contextStyles
  if (payload.stylePriorities) target.stylePriorities = payload.stylePriorities
  else delete target.stylePriorities
  if (payload.contextStylePriorities) {
    target.contextStylePriorities = payload.contextStylePriorities
  } else {
    delete target.contextStylePriorities
  }
  if (payload.rawCss !== undefined) target.rawCss = payload.rawCss
  else delete target.rawCss
}

export interface ConsolidatedRule {
  selector: string
  source: NewStyleRule
  payload: RulePayload
}

export function consolidateIncomingRules(rules: NewStyleRule[]): ConsolidatedRule[] {
  const bySelector = new Map<string, ConsolidatedRule>()
  for (const rule of rules) {
    const selector = styleRuleSelector(rule)
    const existing = bySelector.get(selector)
    if (!existing) {
      const item = { selector, source: rule, payload: payloadFromRule(rule) }
      bySelector.set(selector, item)
      continue
    }
    // Multiple authored blocks with the same selector collapse exactly as the
    // CSS cascade would: a prior important value beats a later normal one;
    // otherwise the later declaration wins and moves to the end.
    existing.payload = mergePayload(existing.payload, payloadFromRule(rule), true)
  }
  return [...bySelector.values()]
}

export function rulesBySelector(rules: Record<string, StyleRule>): Map<string, StyleRule[]> {
  const index = new Map<string, StyleRule[]>()
  for (const rule of Object.values(rules)) {
    const selector = styleRuleSelector(rule)
    const matches = index.get(selector)
    if (matches) matches.push(rule)
    else index.set(selector, [rule])
  }
  return index
}

export interface RuleUpsertResult {
  created: number
  updated: number
}

/**
 * Register `conditions` and upsert `incoming` rules into a site draft by
 * exact emitted selector: existing matches are patched (`merge`) or made
 * authoritative (`replace`) in place — identity, cascade order, assignments
 * and metadata survive — and unknown selectors append in authored order.
 * Callers gate locked (framework) selectors BEFORE calling this.
 */
export function upsertRulesIntoSite(
  site: SiteDocument,
  incoming: ConsolidatedRule[],
  conditions: ConditionDef[],
  mode: 'merge' | 'replace',
  now: number,
): RuleUpsertResult {
  if (conditions.length > 0) {
    if (!site.conditions) site.conditions = []
    const known = new Set(site.conditions.map((c) => c.id))
    for (const def of conditions) {
      if (known.has(def.id)) continue
      known.add(def.id)
      site.conditions.push(def)
    }
  }

  const targetBySelector = rulesBySelector(site.styleRules)
  let maxOrder = -1
  for (const rule of Object.values(site.styleRules)) {
    if (typeof rule.order === 'number' && rule.order > maxOrder) maxOrder = rule.order
  }

  let created = 0
  let updated = 0
  for (const item of incoming) {
    const targets = targetBySelector.get(item.selector) ?? []
    if (targets.length > 0) {
      for (const target of targets) {
        const current = payloadFromRule(target)
        const next = mode === 'replace' ? item.payload : mergePayload(current, item.payload, false)
        if (payloadEqual(current, next)) continue
        writePayload(target, next)
        target.updatedAt = now
        updated++
      }
      continue
    }

    const id = nanoid()
    const newRule: StyleRule = {
      ...item.source,
      ...item.payload,
      id,
      order: (maxOrder += 1),
      createdAt: now,
      updatedAt: now,
    }
    site.styleRules[id] = newRule
    targetBySelector.set(item.selector, [newRule])
    created++
  }

  return { created, updated }
}
