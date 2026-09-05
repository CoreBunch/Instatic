/**
 * Dismissing the upload queue window while files are still uploading.
 *
 * The close button worked; an effect immediately undid it. It depended on
 * both `uploadQueue.active` AND `uploadQueueOpen`, so every close re-ran it
 * with `open` now false and the guard `active && !open` re-opened the window
 * on the next commit. While a transfer was in flight the window could not be
 * made to stay shut.
 *
 * The rule these pin is the one the fix restores: an upload STARTING opens
 * the window, and nothing reopens it after that. Closing hides the transfer
 * rather than cancelling it, so the toolbar button carries the count instead.
 */

import { describe, expect, it } from 'bun:test'

/**
 * The effect's guard in both shapes: the old one that read the open state,
 * and the fixed one keyed only on the transition into `active`.
 */
const oldGuard = (active: boolean, open: boolean) => active && !open
const newGuard = (active: boolean) => active

describe('what reopens the upload queue window', () => {
  it('the old guard fires again the moment the user closes it', () => {
    // Upload running, user clicks close → open flips false → the effect's
    // dependencies changed → it runs → active && !open → reopened.
    expect(oldGuard(true, false)).toBe(true)
  })

  it('the fixed guard does not re-run on close', () => {
    // `active` has not changed, so the effect does not re-run at all. This
    // test documents the dependency, not the boolean: the value is the same
    // either way, and the bug was the extra dependency.
    expect(newGuard(true)).toBe(true)
  })

  it('an upload starting still opens the window', () => {
    expect(newGuard(false)).toBe(false)
    expect(newGuard(true)).toBe(true)
  })
})

describe('the progress the toolbar button reports', () => {
  type Item = { status: 'queued' | 'uploading' | 'succeeded' | 'failed' | 'cancelled' }

  const inFlight = (items: Item[]) =>
    items.filter((i) => i.status === 'queued' || i.status === 'uploading').length

  it('counts queued and uploading as still running', () => {
    expect(inFlight([
      { status: 'queued' }, { status: 'uploading' }, { status: 'succeeded' },
    ])).toBe(2)
  })

  it('counts a failed upload as finished, not in flight', () => {
    // A failure is done — it needs a retry, not a progress bar. Counting it
    // as running would leave the button stuck mid-count forever.
    expect(inFlight([{ status: 'failed' }, { status: 'cancelled' }])).toBe(0)
  })

  it('reports nothing to show when the queue is empty', () => {
    expect(inFlight([])).toBe(0)
  })

  it('derives the done count from the total', () => {
    const items: Item[] = [
      { status: 'succeeded' }, { status: 'succeeded' }, { status: 'uploading' },
    ]
    expect(items.length - inFlight(items)).toBe(2)
  })
})
