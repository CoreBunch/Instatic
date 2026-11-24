import type { MergeFieldChange } from '@core/branches'
import { isDeepStrictEqual } from 'node:util'
import { isRecord } from '@core/utils/isRecord'

interface FieldChangeOptions {
  prefix: string
  conflicts: ReadonlySet<string>
  skip?: ReadonlySet<string>
  labels?: Readonly<Record<string, string>>
  /** Customize a path segment using the site's vocabulary, e.g. a CSS selector. */
  segmentLabel?: (path: readonly string[]) => string | undefined
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function fieldLabel(key: string): string {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) return key
  return key[0]!.toUpperCase() + key.slice(1).replace(/[A-Z]/g, letter => ' ' + letter.toLowerCase())
}

function itemName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  for (const name of [value.selector, value.label, value.name, value.title]) {
    if (typeof name === 'string' && name.trim()) return name
  }
  return undefined
}

/** Breakpoints, repeater items and similar ordered records have stable ids. */
function indexById(items: readonly unknown[]): Map<string, number> | null {
  const index = new Map<string, number>()
  for (const [position, item] of items.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || index.has(item.id)) return null
    index.set(item.id, position)
  }
  return index
}

function displayValue(value: unknown): string | null {
  if (value === undefined) return null
  if (value === null) return 'No value'
  if (value === '') return 'Empty text'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`
  if (isRecord(value)) {
    const size = Object.keys(value).length
    return itemName(value) ?? `${size} ${size === 1 ? 'field' : 'fields'}`
  }
  return String(value)
}

/** Compare stored values before formatting. A leaf row carries both its display
 * label and its original merge path, so two fields with the same label stay distinct. */
export function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>, options: FieldChangeOptions): MergeFieldChange[] {
  const rows: MergeFieldChange[] = []
  const conflicts = [...options.conflicts]

  function addRow(path: string[], label: string, a: unknown, b: unknown) {
    const mergePath = options.prefix + path.join('.')
    rows.push({
      id: path.map(escapePathSegment).join('/'),
      label,
      before: displayValue(a),
      after: displayValue(b),
      conflict: conflicts.some(p => p === mergePath || p.startsWith(mergePath + '.') || mergePath.startsWith(p + '.')),
    })
  }

  function visitList(path: string[], label: string, left: unknown[], right: unknown[]) {
    const beforeIds = indexById(left)
    const afterIds = indexById(right)
    if (beforeIds && afterIds) {
      const common = [...beforeIds.keys()].filter(id => afterIds.has(id))
      const commonAfter = [...afterIds.keys()].filter(id => beforeIds.has(id))
      const reordered = common.some((id, i) => id !== commonAfter[i])
      for (const id of new Set([...afterIds.keys(), ...beforeIds.keys()])) {
        const from = beforeIds.get(id)
        const to = afterIds.get(id)
        const a = from === undefined ? undefined : left[from]
        const b = to === undefined ? undefined : right[to]
        const next = [...path, id]
        const name = itemName(b ?? a) ?? `Item ${(to ?? from!) + 1}`
        const itemLabel = `${label} › ${name}`
        if (reordered && from !== undefined && to !== undefined && from !== to) {
          addRow(next, `${itemLabel} › Position`, from + 1, to + 1)
        }
        visit(next, itemLabel, a, b)
      }
      return
    }
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      visit([...path, String(i)], `${label} › Item ${i + 1}`, left[i], right[i])
    }
  }

  function visit(path: string[], label: string, a: unknown, b: unknown) {
    if (isDeepStrictEqual(a, b)) return
    const bothRecords = isRecord(a) && isRecord(b)
    if (bothRecords || ((a === undefined || b === undefined) && isRecord(a ?? b))) {
      const left = isRecord(a) ? a : {}
      const right = isRecord(b) ? b : {}
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
      // A named addition/removal (a rule, breakpoint, etc.) fits in one row.
      if (bothRecords || (keys.length && !itemName(a ?? b))) {
        for (const key of keys) {
          const next = [...path, key]
          const x = own(left, key)
          const y = own(right, key)
          const entry = y ?? x
          const entryLabel = isRecord(entry) && entry.id === key ? itemName(entry) : undefined
          const segment = options.segmentLabel?.(next) ?? entryLabel ?? fieldLabel(key)
          visit(next, segment ? `${label} › ${segment}` : label, x, y)
        }
        return
      }
    }
    if ((Array.isArray(a) || a === undefined) && (Array.isArray(b) || b === undefined)) {
      const left: unknown[] = a ?? []
      const right: unknown[] = b ?? []
      if (left.length || right.length) {
        visitList(path, label, left, right)
        return
      }
    }
    addRow(path, label, a, b)
  }

  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (options.skip?.has(key)) continue
    const a = own(before, key)
    const b = own(after, key)
    if (a == null && b == null) continue
    const label = options.labels && Object.hasOwn(options.labels, key) ? options.labels[key]! : fieldLabel(key)
    visit([key], label, a, b)
  }
  return rows
}

// Escape JSON Pointer segments, including user-defined field names containing slashes.
function escapePathSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}
