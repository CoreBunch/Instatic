import { useLayoutEffect, useState, type RefObject } from 'react'

type ToolbarLayout = 'expanded' | 'compact' | 'two-rows'

/** Measure the unclipped rows so folding stays stable throughout the animation. */
export function useCanvasToolbarLayout(
  canvas: RefObject<HTMLDivElement | null>,
  showToolbar: boolean,
  showContext: boolean,
  phone: boolean,
) {
  const [layout, setLayout] = useState<ToolbarLayout>('expanded')
  useLayoutEffect(() => {
    const root = canvas.current
    if (!root || !showToolbar || typeof ResizeObserver === 'undefined') return

    const insert = root.querySelector<HTMLElement>('[data-canvas-insert-notch]')
    const context = showContext ? root.querySelector<HTMLElement>('[data-canvas-context-notch]') : null
    const mode = root.querySelector<HTMLElement>('[data-canvas-mode-pill]')
    const folds = root.querySelectorAll<HTMLElement>('[data-notch-fold]')

    function widths(notch: HTMLElement | null) {
      const fold = notch?.querySelector('[data-notch-fold]')
      const row = fold?.querySelector('[data-notch-row]')
      const fixed = (notch?.getBoundingClientRect().width ?? 0) - (fold?.getBoundingClientRect().width ?? 0)
      return { fixed, expanded: fixed + (row?.getBoundingClientRect().width ?? 0) }
    }

    const measure = () => {
      const insertWidth = widths(insert)
      const contextWidth = widths(context)
      const modeWidth = mode?.getBoundingClientRect().width ?? 0
      // Leave clearance for the two 16px inverted corners.
      const side = Math.max(modeWidth, contextWidth.expanded) + 16
      const shouldFold = root.clientWidth < insertWidth.expanded + 2 * side
      const needsTwoRows = !phone && root.clientWidth < insertWidth.fixed + modeWidth + contextWidth.fixed + 32
      if (shouldFold && insert?.querySelector('[data-notch-fold]')?.contains(document.activeElement)) {
        insert.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')?.focus({ preventScroll: true })
      }
      setLayout(shouldFold ? (needsTwoRows ? 'two-rows' : 'compact') : 'expanded')
    }

    const observer = new ResizeObserver(measure)
    observer.observe(root)
    if (mode) observer.observe(mode)
    for (const fold of folds) {
      const row = fold.querySelector('[data-notch-row]')
      if (row) observer.observe(row)
    }
    measure()
    return () => observer.disconnect()
  }, [canvas, showToolbar, showContext, phone])
  return layout
}
