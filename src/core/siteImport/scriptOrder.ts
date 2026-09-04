/**
 * scriptOrder — one load order for scripts shared across imported pages.
 *
 * Every imported script gets ONE `priority` in `site.runtime.scripts`, and the
 * renderer sorts a page's scripts by it. So the order has to satisfy every
 * page at once: if `index.html` loads `vendor.js` before `app.js`, `app.js`
 * must sort after `vendor.js` even though `about.html` (which sorts first by
 * path) links only `app.js`.
 *
 * Each page's sequence contributes "a before b" edges between neighbours;
 * the merged order is a topological sort of that graph, breaking ties by the
 * order scripts were first seen so unrelated scripts keep their page order
 * and the result is deterministic. When two pages genuinely disagree (a cycle),
 * the first-seen script wins and the cycle is reported as a
 * `script-order-conflict` warning rather than silently picking.
 */

import type { ImportWarning } from './types'

export interface PageScriptSequence {
  /** HTML FileMap path, for the conflict message. */
  source: string
  /** Script paths in the page's document order (duplicates already dropped). */
  paths: string[]
}

export interface MergedScriptOrder {
  /** Every script path from every sequence, in load order. */
  order: string[]
  warnings: ImportWarning[]
}

export function mergeScriptOrder(sequences: readonly PageScriptSequence[]): MergedScriptOrder {
  const firstSeen = new Map<string, number>()
  const successors = new Map<string, Set<string>>()
  const indegree = new Map<string, number>()

  const register = (path: string): void => {
    if (firstSeen.has(path)) return
    firstSeen.set(path, firstSeen.size)
    successors.set(path, new Set())
    indegree.set(path, 0)
  }

  for (const { paths } of sequences) {
    for (const path of paths) register(path)
    for (let i = 1; i < paths.length; i += 1) {
      const from = paths[i - 1]!
      const to = paths[i]!
      if (from === to) continue
      const out = successors.get(from)!
      if (out.has(to)) continue
      out.add(to)
      indegree.set(to, indegree.get(to)! + 1)
    }
  }

  const remaining = new Set(firstSeen.keys())
  const order: string[] = []
  const warnings: ImportWarning[] = []

  const earliest = (candidates: Iterable<string>): string | null => {
    let best: string | null = null
    for (const path of candidates) {
      if (best === null || firstSeen.get(path)! < firstSeen.get(best)!) best = path
    }
    return best
  }

  while (remaining.size > 0) {
    const ready = [...remaining].filter((path) => indegree.get(path) === 0)
    let next = earliest(ready)
    if (next === null) {
      // Every remaining script waits on another one: the pages contradict
      // each other. Emit the script that appeared first and report the cycle
      // it sits in, then carry on with the graph minus that script.
      next = earliest(remaining)!
      const cycle = cycleMembers(next, successors, remaining, firstSeen)
      warnings.push({
        kind: 'script-order-conflict',
        message:
          `Imported pages load ${cycle.join(', ')} in contradictory orders — no single load order `
          + 'satisfies every page. Keeping the order from the page that links them first.',
        path: next,
      })
    }
    remaining.delete(next)
    order.push(next)
    for (const to of successors.get(next)!) {
      if (remaining.has(to)) indegree.set(to, indegree.get(to)! - 1)
    }
  }

  return { order, warnings }
}

/**
 * Scripts on the same cycle as `start`: reachable from it AND able to reach
 * it, restricted to scripts not yet ordered. Sorted by first appearance so the
 * message reads in page order.
 */
function cycleMembers(
  start: string,
  successors: Map<string, Set<string>>,
  remaining: Set<string>,
  firstSeen: Map<string, number>,
): string[] {
  const forward = reachable(start, (path) => successors.get(path)!, remaining)
  const predecessors = new Map<string, Set<string>>()
  for (const [from, tos] of successors) {
    for (const to of tos) {
      const set = predecessors.get(to) ?? new Set<string>()
      set.add(from)
      predecessors.set(to, set)
    }
  }
  const backward = reachable(start, (path) => predecessors.get(path) ?? new Set(), remaining)
  const members = new Set([start, ...[...forward].filter((path) => backward.has(path))])
  return [...members].sort((a, b) => firstSeen.get(a)! - firstSeen.get(b)!)
}

function reachable(
  start: string,
  neighbours: (path: string) => Set<string>,
  within: Set<string>,
): Set<string> {
  const seen = new Set<string>()
  const stack = [...neighbours(start)].filter((path) => within.has(path))
  while (stack.length > 0) {
    const path = stack.pop()!
    if (seen.has(path)) continue
    seen.add(path)
    for (const next of neighbours(path)) {
      if (within.has(next) && !seen.has(next)) stack.push(next)
    }
  }
  return seen
}
