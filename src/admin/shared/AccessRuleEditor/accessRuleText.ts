import type { AccessRule } from '@core/members'

/** One short line naming who may open something, for a marker or a tooltip. */
export function describeAccessRule(rule: AccessRule): string {
  if (rule.level === 'public') return 'Anyone'
  if (rule.level === 'members') return 'Signed-in members only'
  return rule.tags.length === 1
    ? `Members with the tag ${rule.tags[0]}`
    : `Members with one of the tags ${rule.tags.join(', ')}`
}

/** A rule is ready to save once a tag rule names at least one tag. */
export function isCompleteAccessRule(rule: AccessRule): boolean {
  return rule.level !== 'tags' || rule.tags.length > 0
}
