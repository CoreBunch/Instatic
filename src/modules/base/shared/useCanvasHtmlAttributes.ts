import { useLayoutEffect, useState, type RefObject } from 'react'
import { normalizeHtmlAttributes } from '@core/htmlAttributes'

/** React treats hidden as boolean. Keep its presence declarative and reflect
 * the authored value (including until-found) when the element or value changes. */
export function useCanvasHiddenAttribute(hidden: string | undefined, editRef?: RefObject<HTMLElement | null>) {
  const [element, setElement] = useState<Element | null>(null)
  useLayoutEffect(() => {
    const target = editRef?.current ?? element
    if (target && hidden !== undefined) target.setAttribute('hidden', hidden)
  }, [element, hidden, editRef])

  if (hidden === undefined) return {}
  // Inline editing supplies its own ref on the element.
  return { hidden: true, ref: setElement }
}

export function useCanvasHtmlAttributes(value: unknown, editRef?: RefObject<HTMLElement | null>) {
  const { hidden, ...attributes } = normalizeHtmlAttributes(value)
  return { ...attributes, ...useCanvasHiddenAttribute(hidden, editRef) }
}
