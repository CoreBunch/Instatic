import type { ImportPlan } from '@core/siteImport'

interface RuleGroup {
  source: string
  label: string
  indices: number[]
}

interface MediaGroup {
  label: string
  sourcePaths: string[]
}

interface SkippedItem {
  label: string
  reason: string
  kind: string
}

/** Group style-rule indices by their source stylesheet, preserving first-seen order. */
export function buildRuleGroups(plan: ImportPlan): RuleGroup[] {
  const order: string[] = []
  const bySource = new Map<string, number[]>()
  plan.styleRuleSources.forEach((src, i) => {
    let bucket = bySource.get(src)
    if (!bucket) {
      bucket = []
      bySource.set(src, bucket)
      order.push(src)
    }
    bucket.push(i)
  })
  return order.map((source) => ({ source, label: basename(source), indices: bySource.get(source) ?? [] }))
}

const MEDIA_ORDER = ['Images', 'SVG', 'GIF', 'Video', 'Other']

/** Bucket assets into display groups by MIME type. */
export function buildMediaGroups(plan: ImportPlan): MediaGroup[] {
  const byLabel = new Map<string, string[]>()
  for (const a of plan.assets) {
    const label = mediaLabel(a.mimeType)
    const bucket = byLabel.get(label)
    if (bucket) bucket.push(a.sourcePath)
    else byLabel.set(label, [a.sourcePath])
  }
  const groups: MediaGroup[] = []
  for (const label of MEDIA_ORDER) {
    const sourcePaths = byLabel.get(label)
    if (sourcePaths) groups.push({ label, sourcePaths })
  }
  return groups
}

/** Items that could not be imported — surfaced under the "Can't import" entry. */
export function buildSkippedList(plan: ImportPlan): SkippedItem[] {
  return [
    ...plan.unusedCss.map((path) => ({
      label: path,
      reason: 'Stylesheet isn’t linked by any imported page',
      kind: 'css',
    })),
    ...plan.droppedAtRules.map((src) => ({
      label: src.length > 72 ? `${src.slice(0, 72)}…` : src,
      reason: 'At-rule the engine can’t model',
      kind: 'at-rule',
    })),
  ]
}

/** Count style rules whose source stylesheet is linked by the given page. */
export function pageRuleCount(plan: ImportPlan, linkedCssPaths: string[]): number {
  const linked = new Set(linkedCssPaths)
  let n = 0
  for (const src of plan.styleRuleSources) if (linked.has(src)) n++
  return n
}

/** The selector text shown for a style rule (the emitted selector, falling back to its name). */
export function ruleText(plan: ImportPlan, index: number): string {
  const rule = plan.styleRules[index]
  if (rule.selector) return rule.selector
  return rule.kind === 'class' ? `.${rule.name}` : rule.name
}

export function styleRuleKey(plan: ImportPlan, index: number): string {
  const rule = plan.styleRules[index]
  const styleSignature = Object.entries(rule.styles)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([property, value]) => `${property}:${String(value)}`)
    .join(';')
  return `${plan.styleRuleSources[index]}::${rule.kind}::${rule.selector ?? ''}::${rule.name}::${styleSignature}`
}

export function skippedItemKey(item: SkippedItem): string {
  return `${item.kind}::${item.label}::${item.reason}`
}

/** Basename of a FileMap key, annotating synthetic inline-`<style>` sources. */
export function basename(path: string): string {
  const real = path.split('::')[0]
  const base = real.split('/').pop() || real
  return path.includes('::inline') ? `${base} (inline)` : base
}

function mediaLabel(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('svg')) return 'SVG'
  if (m === 'image/gif') return 'GIF'
  if (m.startsWith('image/')) return 'Images'
  if (m.startsWith('video/')) return 'Video'
  return 'Other'
}
