export interface AgentPreviewImage {
  id: string
  src: string
  alt: string
  title?: string
  filename?: string
}

export interface AgentImageMenuRequest {
  image: AgentPreviewImage
  x: number
  y: number
  returnFocus: HTMLElement | null
}

export type OpenAgentImageMenu = (request: AgentImageMenuRequest) => void

export function isContextMenuKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

export function keyboardImageMenuPosition(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + Math.min(Math.max(rect.width - 8, 0), 24),
    y: rect.top + Math.min(Math.max(rect.height - 8, 0), 24),
  }
}
