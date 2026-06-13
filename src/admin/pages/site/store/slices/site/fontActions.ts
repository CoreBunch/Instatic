/**
 * Site fonts library mutations: installed font assets + builder-facing tokens.
 *
 * The store actions are purely client-side mutations on `settings.fonts.items`.
 * The caller (UI) owns the server install/cleanup flow and passes the
 * resulting `FontEntry` here; duplicate `family` (case-insensitive) on the
 * same `source` re-installs (replacing the existing entry).
 */

import { nanoid } from 'nanoid'
import type { Draft } from 'mutative'
import type { BaseNode, SiteDocument } from '@core/page-tree'
import type { FontEntry, FontToken, SiteFontsSettings } from '@core/fonts'
import {
  defaultFontTokenFallback,
  isDuplicateFontTokenVariable,
  makeUniqueFontTokenVariable,
  normalizeFontTokenVariable,
  sanitizeFontFallbackStack,
} from '@core/fonts'
import type { SiteSlice, SiteSliceHelpers } from './types'

type FontActions = Pick<
  SiteSlice,
  | 'addFont'
  | 'removeFont'
  | 'createFontToken'
  | 'updateFontToken'
  | 'deleteFontToken'
>

function ensureFonts(site: Draft<SiteDocument>): Draft<SiteFontsSettings> {
  site.settings.fonts ??= { items: [] }
  site.settings.fonts.tokens ??= []
  return site.settings.fonts
}

function nextTokenOrder(tokens: ReadonlyArray<FontToken>): number {
  return tokens.reduce((max, token) => Math.max(max, token.order), -1) + 1
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rewriteFontVariableValue(value: unknown, oldVariable: string, nextVariable: string): unknown {
  if (typeof value !== 'string') return value
  const oldName = normalizeFontTokenVariable(oldVariable)
  const nextName = normalizeFontTokenVariable(nextVariable)
  if (!oldName || !nextName || oldName === nextName) return value
  const re = new RegExp(`var\\(\\s*--${escapeRegExp(oldName)}\\s*\\)`, 'g')
  return value.replace(re, `var(--${nextName})`)
}

function rewriteStyleBagFontVariable(
  bag: Record<string, unknown> | undefined,
  oldVariable: string,
  nextVariable: string,
): boolean {
  if (!bag) return false
  let changed = false
  for (const [key, value] of Object.entries(bag)) {
    const rewritten = rewriteFontVariableValue(value, oldVariable, nextVariable)
    if (!Object.is(rewritten, value)) {
      bag[key] = rewritten
      changed = true
    }
  }
  return changed
}

function rewriteNodeMapFontVariable(
  nodes: Record<string, BaseNode>,
  oldVariable: string,
  nextVariable: string,
): boolean {
  let changed = false
  for (const node of Object.values(nodes)) {
    if (rewriteStyleBagFontVariable(node.inlineStyles, oldVariable, nextVariable)) changed = true
  }
  return changed
}

function rewriteSiteFontVariableReferences(
  site: Draft<SiteDocument>,
  oldVariable: string,
  nextVariable: string,
): boolean {
  let changed = false
  for (const rule of Object.values(site.styleRules)) {
    if (rewriteStyleBagFontVariable(rule.styles, oldVariable, nextVariable)) changed = true
    for (const contextBag of Object.values(rule.contextStyles ?? {})) {
      if (rewriteStyleBagFontVariable(contextBag, oldVariable, nextVariable)) changed = true
    }
  }
  for (const page of site.pages) {
    if (rewriteNodeMapFontVariable(page.nodes, oldVariable, nextVariable)) changed = true
  }
  for (const vc of site.visualComponents) {
    if (rewriteNodeMapFontVariable(vc.tree.nodes, oldVariable, nextVariable)) changed = true
  }
  return changed
}

function createTokenFromInput(
  fonts: Draft<SiteFontsSettings>,
  input: SiteSlice['createFontToken'] extends (arg: infer Input) => FontToken ? Input : never,
): FontToken {
  const now = Date.now()
  const family = input.familyId
    ? fonts.items.find((entry) => entry.id === input.familyId)
    : undefined
  const desiredVariable = input.variable ?? input.name
  return {
    id: nanoid(),
    name: input.name.trim() || 'Font',
    variable: makeUniqueFontTokenVariable(desiredVariable, fonts.tokens ?? []),
    ...(family ? { familyId: family.id } : {}),
    fallback: sanitizeFontFallbackStack(input.fallback ?? defaultFontTokenFallback(family)),
    order: nextTokenOrder(fonts.tokens ?? []),
    createdAt: now,
    updatedAt: now,
  }
}

export function createFontActions({
  mutateSite,
}: SiteSliceHelpers): FontActions {
  return {
    addFont: (entry) => {
      let committed: FontEntry = entry
      mutateSite((site) => {
        const lib = ensureFonts(site)
        const familyLower = entry.family.toLowerCase()
        const sameIdIndex = lib.items.findIndex((f) => f.id === entry.id)
        const sameFamilyIndex = lib.items.findIndex(
          (f) => f.family.toLowerCase() === familyLower && f.source === entry.source,
        )
        const idx = sameIdIndex >= 0 ? sameIdIndex : sameFamilyIndex
        const previousId = idx >= 0 ? lib.items[idx].id : null
        if (idx >= 0) {
          // Re-install of the same font: replace the existing entry so newly
          // selected variants/subsets supersede the previous selection.
          committed = { ...entry, updatedAt: Date.now() }
          lib.items[idx] = committed
          if (previousId && previousId !== committed.id) {
            for (const token of lib.tokens ?? []) {
              if (token.familyId === previousId) token.familyId = committed.id
            }
          }
        } else {
          lib.items.push(entry)
          committed = entry
        }
        return true
      })
      return committed
    },

    removeFont: (fontId) => {
      return mutateSite((site) => {
        if (!site.settings.fonts) return false
        if (site.settings.fonts.tokens?.some((token) => token.familyId === fontId)) return false
        const nextItems = site.settings.fonts.items.filter((font) => font.id !== fontId)
        if (nextItems.length === site.settings.fonts.items.length) return false
        site.settings.fonts.items = nextItems
        return true
      })
    },

    createFontToken: (input) => {
      let token: FontToken | null = null
      mutateSite((site) => {
        const fonts = ensureFonts(site)
        token = createTokenFromInput(fonts, input)
        fonts.tokens?.push(token)
        return true
      })
      if (!token) throw new Error('No site loaded')
      return token
    },

    updateFontToken: (tokenId, patch) => {
      mutateSite((site) => {
        const fonts = site.settings.fonts
        const token = fonts?.tokens?.find((item) => item.id === tokenId)
        if (!fonts || !token) return false

        let changed = false
        const oldVariable = token.variable

        if (patch.name !== undefined) {
          const nextName = patch.name.trim()
          if (nextName && nextName !== token.name) {
            token.name = nextName
            changed = true
          }
        }

        if (patch.variable !== undefined) {
          const nextVariable = normalizeFontTokenVariable(patch.variable)
          if (!nextVariable) throw new Error('Font token variable is required')
          if (isDuplicateFontTokenVariable(nextVariable, fonts.tokens ?? [], tokenId)) {
            throw new Error(`Font token variable "${nextVariable}" already exists`)
          }
          if (nextVariable !== token.variable) {
            token.variable = nextVariable
            changed = true
            rewriteSiteFontVariableReferences(site, oldVariable, nextVariable)
          }
        }

        if (patch.familyId !== undefined) {
          const nextFamilyId = patch.familyId
          if (nextFamilyId === null || nextFamilyId === '') {
            if (token.familyId !== undefined) {
              delete token.familyId
              changed = true
            }
          } else if (fonts.items.some((entry) => entry.id === nextFamilyId) && token.familyId !== nextFamilyId) {
            token.familyId = nextFamilyId
            changed = true
          }
        }

        if (patch.fallback !== undefined) {
          const nextFallback = sanitizeFontFallbackStack(patch.fallback)
          if (nextFallback !== token.fallback) {
            token.fallback = nextFallback
            changed = true
          }
        }

        if (patch.order !== undefined && Number.isFinite(patch.order) && patch.order !== token.order) {
          token.order = patch.order
          changed = true
        }

        if (!changed) return false
        token.updatedAt = Date.now()
        return true
      })
    },

    deleteFontToken: (tokenId) => {
      return mutateSite((site) => {
        if (!site.settings.fonts?.tokens) return false
        const nextTokens = site.settings.fonts.tokens.filter((token) => token.id !== tokenId)
        if (nextTokens.length === site.settings.fonts.tokens.length) return false
        site.settings.fonts.tokens = nextTokens
        return true
      })
    },
  }
}
