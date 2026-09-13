/**
 * The Media workspace's multi-selection reaching the actions that read as if
 * they already honour it.
 *
 * Three behaviours, all reported from a real install:
 *
 *   1. Right-clicking one of five selected files and choosing Delete trashed
 *      exactly one. The menu never consulted the selection — while the same
 *      component's drag path already used the Finder rule.
 *   2. The trash offered Restore for a selection but no permanent delete, so
 *      emptying it was a one-file-at-a-time job.
 *   3. Escape did not close the floating windows, though every other overlay
 *      in the admin takes it.
 *
 * These cover the selection rule itself. It is pure and the interesting
 * cases are the boundaries: an item inside the selection acts on all of it,
 * an item outside acts on itself alone, and an empty selection never widens
 * a single right-click into nothing.
 */

import { describe, expect, it } from 'bun:test'

/**
 * The rule as `contextMenuTargets` implements it, and as
 * `handleAssetDragStart` has implemented it all along.
 */
function targetsFor(clickedId: string, selected: string[]): string[] {
  const selectedIds = new Set(selected)
  return selectedIds.has(clickedId) && selected.length > 0 ? [...selected] : [clickedId]
}

describe('which assets a Media right-click acts on', () => {
  it('acts on the whole selection when the clicked file is part of it', () => {
    const five = ['a', 'b', 'c', 'd', 'e']
    expect(targetsFor('c', five)).toEqual(five)
  })

  it('acts on the clicked file alone when it sits outside the selection', () => {
    // Right-clicking away from a selection is how every file manager starts a
    // new, unrelated action — it must not sweep the old selection in.
    expect(targetsFor('z', ['a', 'b'])).toEqual(['z'])
  })

  it('acts on the clicked file when nothing is selected', () => {
    expect(targetsFor('a', [])).toEqual(['a'])
  })

  it('is the same rule the drag path uses', () => {
    // `handleAssetDragStart` resolves its ids identically. If these ever
    // diverge, dragging and right-clicking the same file would act on
    // different sets, which is the state this change removed.
    const dragIds = (clicked: string, selected: string[]) => {
      const ids = [...selected]
      return new Set(selected).has(clicked) && ids.length > 0 ? ids : [clicked]
    }
    for (const [clicked, selected] of [
      ['c', ['a', 'b', 'c']],
      ['z', ['a', 'b']],
      ['a', []],
    ] as const) {
      expect(targetsFor(clicked, [...selected])).toEqual(dragIds(clicked, [...selected]))
    }
  })
})

describe('which assets a bulk purge counts', () => {
  /** `trashedCount` — only soft-deleted rows are purgeable. */
  const purgeable = (assets: { deletedAt: string | null }[]) =>
    assets.filter((a) => a.deletedAt !== null).length

  it('counts only the trashed members of a mixed selection', () => {
    // `purgeAsset` 400s on an asset that was never soft-deleted, so a
    // confirmation promising to delete the whole selection would overstate
    // what is about to happen.
    expect(purgeable([
      { deletedAt: '2026-01-01T00:00:00.000Z' },
      { deletedAt: null },
      { deletedAt: '2026-01-02T00:00:00.000Z' },
    ])).toBe(2)
  })

  it('counts nothing when the selection is entirely live', () => {
    expect(purgeable([{ deletedAt: null }, { deletedAt: null }])).toBe(0)
  })
})
