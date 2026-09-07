import { Type } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'

const LocaleNodeCellKeySchema = Type.Union([
  Type.Tuple([Type.String()]),
  Type.Tuple([Type.String(), Type.String()]),
  Type.Tuple([Type.String(), Type.String(), Type.String()]),
])

/** One shared map entry per value: first edits never race to create a node container. */
export function localeNodeCellKey(nodeId: string, property?: string, parameter?: string): string {
  return JSON.stringify(parameter !== undefined ? [nodeId, property, parameter] : property !== undefined ? [nodeId, property] : [nodeId])
}

export function readLocaleNodeCellKey(key: string) {
  const parsed = safeParseJson(key, LocaleNodeCellKeySchema)
  if (!parsed.ok) throw new Error('Invalid localized node cell key', { cause: parsed.error })
  return parsed.value
}
