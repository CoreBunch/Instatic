/**
 * useScrollSpy — derives the active `[data-style-section]` from a scroll
 * container's position and exposes a click-to-scroll helper.
 *
 * Both the node properties surface (StyleSurface) and the global selector
 * inspector (SelectorInspector) render a column of `[data-style-section]`
 * blocks beside a category rail. The rail highlights whichever section sits
 * closest to (but not past) the container top, and clicking a rail button
 * scrolls that section into view. This hook is that shared machinery.
 *
 *   - `activeId` tracks the nearest section above the container top, falling
 *     back to `initialId` when none is above it (top of scroll).
 *   - `scrollTo(sectionId)` scrolls the matching section to the top of the
 *     container, honouring the `propertiesSmoothScroll` preference. When
 *     `scrollTopId` is provided and matches the clicked id, it scrolls to the
 *     absolute top.
 *   - When `resetKey` changes (e.g. the selected node), `activeId` resets to
 *     `initialId` (during render, no stale-highlight flash) and the container
 *     scrolls back to the top.
 */

import { useCallback, useEffect, useState, type RefObject } from 'react'
import { useEditorPreference } from '@site/preferences/editorPreferences'

interface ScrollSpyOptions {
  /** Active id when the container is scrolled above the first section. */
  initialId: string
  /**
   * Optional anchor whose click scrolls to the absolute top (offset 0) rather
   * than to the section's own offset. Omit when every anchor is a real section.
   */
  scrollTopId?: string
  /**
   * Optional context key. When it changes, the active anchor resets to
   * `initialId` and the container scrolls back to the top. Omit when the
   * surface has no context to reset on.
   */
  resetKey?: string | null
}

interface ScrollSpy {
  activeId: string
  scrollTo: (sectionId: string) => void
}

export function useScrollSpy(
  containerRef: RefObject<HTMLDivElement | null>,
  { initialId, scrollTopId, resetKey }: ScrollSpyOptions,
): ScrollSpy {
  const [activeId, setActiveId] = useState<string>(initialId)

  // Reset the active anchor on context change ("update during render" so the
  // rail never flashes the previous context's highlight).
  const [lastResetKey, setLastResetKey] = useState<string | null | undefined>(resetKey)
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey)
    setActiveId(initialId)
  }

  // Smooth-scroll behaviour gated by the `propertiesSmoothScroll` preference.
  // Read fresh so toggling the pref takes effect on the very next click.
  const propertiesSmoothScroll = useEditorPreference('propertiesSmoothScroll')

  // `useCallback` keeps a stable identity for the scroll-listener effect
  // dependency below — `react-hooks/exhaustive-deps` can't see the React
  // Compiler's runtime memoization, so the effect needs it explicitly.
  const updateActive = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const sections = container.querySelectorAll<HTMLElement>('[data-style-section]')
    const containerRect = container.getBoundingClientRect()
    let nextId = initialId
    let closestAboveTop = -Infinity
    for (const section of Array.from(sections)) {
      const id = section.getAttribute('data-style-section')
      if (!id) continue
      const relTop = section.getBoundingClientRect().top - containerRect.top
      if (relTop <= 1 && relTop > closestAboveTop) {
        closestAboveTop = relTop
        nextId = id
      }
    }
    setActiveId(nextId)
  }, [containerRef, initialId])

  // Derive active anchor from scroll position via a passive scroll listener.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('scroll', updateActive, { passive: true })
    return () => container.removeEventListener('scroll', updateActive)
  }, [containerRef, updateActive])

  // Scroll back to top on context change (DOM mutation — safe in effect).
  useEffect(() => {
    if (resetKey === undefined) return
    containerRef.current?.scrollTo({ top: 0 })
  }, [containerRef, resetKey])

  const scrollTo = (sectionId: string) => {
    const container = containerRef.current
    if (!container) return
    const behavior: ScrollBehavior = propertiesSmoothScroll ? 'smooth' : 'auto'

    setActiveId(sectionId)

    if (sectionId === scrollTopId) {
      container.scrollTo({ top: 0, behavior })
      return
    }

    const el = container.querySelector<HTMLElement>(`[data-style-section="${sectionId}"]`)
    if (!el) return
    const containerRect = container.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    container.scrollTo({ top: rect.top - containerRect.top + container.scrollTop, behavior })
  }

  return { activeId, scrollTo }
}
