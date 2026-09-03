/**
 * Three-way merge of JSON values.
 *
 * `base` is what both sides started from, `ours` is the side receiving the
 * merge, `theirs` the side being merged in. Plain objects merge key by key;
 * everything else (arrays, scalars, page trees inside a cell) is atomic —
 * a value either moved on one side only, on both sides identically, or it
 * conflicts. Conflicts keep `ours` and are reported by path so a reviewer
 * can decide; nothing here ever invents a value neither side wrote.
 */
import { canonicalJson } from '@core/utils/canonicalJson'

export interface JsonMergeResult {
  value: unknown
  /** Paths (`a.b.c`) where both sides changed the same value differently. */
  conflicts: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function same(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b
  return canonicalJson(a) === canonicalJson(b)
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function mergeValue(base: unknown, ours: unknown, theirs: unknown, path: string, conflicts: string[]): unknown {
  if (same(ours, theirs)) return ours
  if (same(theirs, base)) return ours
  if (same(ours, base)) return theirs
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const baseObject = isPlainObject(base) ? base : {}
    const merged: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(baseObject)])
    for (const key of keys) {
      const value = mergeValue(baseObject[key], ours[key], theirs[key], joinPath(path, key), conflicts)
      if (value !== undefined) merged[key] = value
    }
    return merged
  }
  conflicts.push(path || '(root)')
  return ours
}

/** Merge `theirs` into `ours` given their common `base`. */
export function mergeJson(base: unknown, ours: unknown, theirs: unknown): JsonMergeResult {
  const conflicts: string[] = []
  const value = mergeValue(base, ours, theirs, '', conflicts)
  return { value, conflicts }
}

/** True when two values serialize identically. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  return same(a, b)
}
