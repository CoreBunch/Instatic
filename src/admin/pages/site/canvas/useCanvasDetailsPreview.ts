import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'

const INTERACTIVE = 'a, button, input, select, textarea, [contenteditable="true"], [data-canvas-interactive="true"]'

function editableDetails(element: Element | null): element is HTMLDetailsElement {
  return element?.tagName === 'DETAILS' && element.hasAttribute('data-node-id') &&
    !element.closest('[data-instatic-readonly-id]')
}

/** DOM-only preview: never writes the page tree, undo history, or collaboration document. */
export function installCanvasDetailsPreview(doc: Document): () => void {
  const activate = (event: Event) => {
    const target = event.target
    // The target belongs to an iframe, so instanceof Element would use the wrong realm.
    if (!target || typeof (target as Element).closest !== 'function') return
    const element = target as Element
    if (element.closest(INTERACTIVE)) return
    const summary = element.closest('summary')
    const details = summary?.parentElement ?? null
    if (!summary || !editableDetails(details) || details.querySelector('summary') !== summary) return
    if (event.type === 'keydown') {
      const keyboard = event as KeyboardEvent
      if (keyboard.key !== 'Enter' && keyboard.key !== ' ') return
      event.preventDefault()
      if (keyboard.repeat) return
    }
    // Cancel the native toggle; React's selection handlers also cancel it.
    // Keep propagation so the clicked layer remains selectable and editable.
    event.preventDefault()
    details.open = !details.open
  }
  doc.addEventListener('click', activate, true)
  doc.addEventListener('keydown', activate, true)
  return () => {
    doc.removeEventListener('click', activate, true)
    doc.removeEventListener('keydown', activate, true)
  }
}

/** Reveal a layer selected inside a closed body, without reopening a clicked summary. */
export function revealSelectedDetails(doc: Document, nodeId: string): void {
  const target = Array.from(doc.querySelectorAll('[data-node-id]'))
    .find((element) => element.getAttribute('data-node-id') === nodeId)
  if (!target) return
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (!editableDetails(ancestor)) continue
    const summary = ancestor.querySelector('summary')
    if (!summary?.contains(target)) ancestor.open = true
  }
}

export function useCanvasDetailsPreview(doc: Document | null): void {
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId)
  useEffect(() => doc ? installCanvasDetailsPreview(doc) : undefined, [doc])
  useEffect(() => {
    if (doc && selectedNodeId) revealSelectedDetails(doc, selectedNodeId)
  }, [doc, selectedNodeId])
}
