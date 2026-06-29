import type { CSSProperties } from 'react'
import type { Page } from '@core/page-tree'
import { registry } from '@core/module-engine'
import type { InsertLocation } from '@site/store/insertLocation'
import {
  getViewportLocalPoint,
  measureCanvasDropCandidates,
} from './canvasDomGeometry'
import {
  resolveCanvasInsertionTarget,
  type CanvasInsertionTarget,
} from './canvasDnd'

const CANVAS_VIEWPORT_SELECTOR = '[data-breakpoint-id]'

export interface CanvasDropPreview {
  left: number
  top: number
  width: number
  height: number
  position: CanvasInsertionTarget['position'] | 'inside'
  label: string
}

export interface CanvasPointerInsertionDrop {
  location: InsertLocation
  preview: CanvasDropPreview
  breakpointId: string
}

interface ResolveCanvasPointerInsertionDropInput {
  canvasPage: Page
  clientX: number
  clientY: number
  label: string
}

export function findCanvasViewportAtPoint(
  clientX: number,
  clientY: number,
): HTMLElement | null {
  const viewports = document.querySelectorAll<HTMLElement>(CANVAS_VIEWPORT_SELECTOR)
  for (const viewport of viewports) {
    const rect = viewport.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return viewport
    }
  }
  return null
}

export function resolveCanvasPointerInsertionDrop({
  canvasPage,
  clientX,
  clientY,
  label,
}: ResolveCanvasPointerInsertionDropInput): CanvasPointerInsertionDrop | null {
  const viewport = findCanvasViewportAtPoint(clientX, clientY)
  if (!viewport) return null
  const breakpointId = viewport.dataset.breakpointId
  if (!breakpointId) return null

  const viewportRect = viewport.getBoundingClientRect()
  if (
    clientX < viewportRect.left ||
    clientX > viewportRect.right ||
    clientY < viewportRect.top ||
    clientY > viewportRect.bottom
  ) {
    return null
  }

  const iframe = viewport.querySelector<HTMLIFrameElement>('iframe')
  const point = getViewportLocalPoint(viewport, clientX, clientY)
  const candidates = measureCanvasDropCandidates(viewport, canvasPage, iframe)
  const target = resolveCanvasInsertionTarget({
    tree: canvasPage,
    candidates,
    point,
    canHaveChildren: (moduleId) => registry.get(moduleId)?.canHaveChildren === true,
  })

  if (!target) {
    return {
      location: { parentId: canvasPage.rootNodeId, index: undefined },
      preview: fixedPreviewForViewport(viewport, 'inside', `${label} at page root`),
      breakpointId,
    }
  }

  return {
    location: { parentId: target.parentId, index: target.index },
    preview: fixedPreviewForTarget(viewport, target, `${label} ${target.position}`),
    breakpointId,
  }
}

export function fixedPreviewForTarget(
  viewport: HTMLElement,
  target: CanvasInsertionTarget,
  label: string,
): CanvasDropPreview {
  const viewportRect = viewport.getBoundingClientRect()
  const scale = viewport.offsetWidth > 0 ? viewportRect.width / viewport.offsetWidth : 1
  return {
    left: viewportRect.left + target.rect.left * scale,
    top: viewportRect.top + target.rect.top * scale,
    width: target.rect.width * scale,
    height: target.rect.height * scale,
    position: target.position,
    label,
  }
}

export function fixedPreviewForViewport(
  viewport: HTMLElement,
  position: CanvasDropPreview['position'],
  label: string,
): CanvasDropPreview {
  const viewportRect = viewport.getBoundingClientRect()
  return {
    left: viewportRect.left,
    top: viewportRect.top,
    width: viewportRect.width,
    height: viewportRect.height,
    position,
    label,
  }
}

export function dropPreviewStyle(preview: CanvasDropPreview): CSSProperties {
  return {
    '--drop-left': `${preview.left}px`,
    '--drop-top': `${preview.top}px`,
    '--drop-width': `${preview.width}px`,
    '--drop-height': `${preview.height}px`,
  } as CSSProperties
}
