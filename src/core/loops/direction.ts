/**
 * Which way a loop runs. A `base.loop` node stores `direction` only once its
 * author picks one; until then the loop follows its source's
 * `defaultDirection`, and a source that declares none lists in the order it
 * returns. One resolver, so the publisher, the infinite-scroll endpoint and
 * the canvas preview agree.
 */

import type { LoopDirection, LoopEntitySource } from './types'

export function resolveLoopDirection(
  stored: unknown,
  source: Pick<LoopEntitySource, 'defaultDirection'> | null | undefined,
): LoopDirection {
  if (stored === 'asc' || stored === 'desc') return stored
  return source?.defaultDirection ?? 'asc'
}
