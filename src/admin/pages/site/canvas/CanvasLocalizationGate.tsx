import type { ReactNode } from 'react'

/** Throws inside the canvas boundary, leaving file authoring available. */
export function CanvasLocalizationGate({ error, children }: { error?: Error; children: ReactNode }) {
  if (error) throw error
  return children
}
