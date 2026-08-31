/**
 * Get-or-create a `<div id="…">` on `document.body` for `createPortal`
 * targets (tooltips, toasts, floating overlays). Idempotent: the element is
 * created on first call and reused for the rest of the document's life.
 */
export function ensurePortalRoot(id: string): HTMLElement {
  let root = document.getElementById(id)
  if (!root) {
    root = document.createElement('div')
    root.id = id
    document.body.appendChild(root)
  }
  return root
}
