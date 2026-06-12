import { Type, type Static } from '@sinclair/typebox'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import type { ModuleInserterItemRef } from '@core/persistence/userPreferences'
import { recentKey } from './moduleInserterModel'

export const MODULE_INSERTER_STORAGE_KEY = 'instatic-module-inserter-v1'

const MAX_RECENT_INSERTIONS = 8

const InserterViewSchema = Type.Union([
  Type.Literal('grid'),
  Type.Literal('list'),
])

const RecentKindSchema = Type.Union([
  Type.Literal('module'),
  Type.Literal('layout'),
  Type.Literal('savedLayout'),
  Type.Literal('component'),
])

const RecentRefSchema = Type.Object({
  kind: RecentKindSchema,
  id: Type.String(),
})

const ModuleInserterPrefsSchema = Type.Object({
  view: InserterViewSchema,
  recent: Type.Array(RecentRefSchema, { maxItems: 32 }),
}, { additionalProperties: false })

type ModuleInserterView = Static<typeof InserterViewSchema>
type ModuleInserterPrefs = Static<typeof ModuleInserterPrefsSchema>
export type ModuleInserterRecentRef = ModuleInserterItemRef

const DEFAULT_PREFS: ModuleInserterPrefs = {
  view: 'grid',
  recent: [],
}

export function readModuleInserterPrefs(): ModuleInserterPrefs {
  try {
    return parseJsonWithFallback(
      localStorage.getItem(MODULE_INSERTER_STORAGE_KEY),
      ModuleInserterPrefsSchema,
      DEFAULT_PREFS,
    )
  } catch {
    return DEFAULT_PREFS
  }
}

export function writeModuleInserterView(view: ModuleInserterView): void {
  writeModuleInserterPrefs({ ...readModuleInserterPrefs(), view })
}

export function trackModuleInserterRecent(ref: ModuleInserterRecentRef): void {
  const prefs = readModuleInserterPrefs()
  const key = recentKey(ref)
  const recent = [
    ref,
    ...prefs.recent.filter((existing) => recentKey(existing) !== key),
  ].slice(0, MAX_RECENT_INSERTIONS)

  writeModuleInserterPrefs({ ...prefs, recent })
}

function writeModuleInserterPrefs(prefs: ModuleInserterPrefs): void {
  try {
    localStorage.setItem(MODULE_INSERTER_STORAGE_KEY, JSON.stringify(prefs))
  } catch (err) {
    console.warn('[module-inserter] Failed to persist preferences:', err)
  }
}


