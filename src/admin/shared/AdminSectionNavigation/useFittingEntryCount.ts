import { useLayoutEffect, useState, type RefObject } from 'react'

interface EntryFit {
  /** How many leading entries stay in the row. */
  count: number
  /** Where the "More" trigger sits, in px from the row's left edge. */
  moreLeft: number
}

/**
 * How many navigation entries fit in the row, leaving room for the "More"
 * trigger when some do not.
 *
 * Every entry stays laid out (the ones out of the row are only made
 * invisible), so its width is always measurable and the row's own box is
 * exactly `min(content, available space)` — no cached widths, and growing the
 * window is detected the same way as shrinking it.
 */
export function useFittingEntryCount(
  rowRef: RefObject<HTMLElement | null>,
  moreRef: RefObject<HTMLElement | null>,
  entryCount: number,
): EntryFit {
  const [fit, setFit] = useState<EntryFit>({ count: entryCount, moreLeft: 0 })

  useLayoutEffect(() => {
    const row = rowRef.current
    const more = moreRef.current
    if (!row || !more) return

    const entries = (): HTMLElement[] =>
      Array.from(row.querySelectorAll<HTMLElement>('[data-admin-nav-entry]'))

    function measure(): void {
      if (!row || !more) return
      const items = entries()
      const available = row.clientWidth
      const last = items[items.length - 1]
      let next: EntryFit
      if (!last || last.offsetLeft + last.offsetWidth <= available) {
        next = { count: items.length, moreLeft: 0 }
      } else {
        const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0
        const room = available - more.offsetWidth
        let count = 0
        while (count < items.length && items[count].offsetLeft + items[count].offsetWidth + gap <= room) {
          count += 1
        }
        const lastKept = items[count - 1]
        next = { count, moreLeft: lastKept ? lastKept.offsetLeft + lastKept.offsetWidth + gap : 0 }
      }
      setFit((current) =>
        current.count === next.count && current.moreLeft === next.moreLeft ? current : next,
      )
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    // The row resizes with the window; an entry or the trigger resizes when a
    // label, a badge or the font changes.
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(more)
    for (const item of entries()) observer.observe(item)
    return () => observer.disconnect()
  }, [rowRef, moreRef, entryCount])

  // Entries added since the last measurement count as fitting until measured.
  return fit.count > entryCount ? { count: entryCount, moreLeft: 0 } : fit
}
