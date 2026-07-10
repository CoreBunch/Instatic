/**
 * DomNodeRenderer — renders a DOM-native PageNode in the editor canvas.
 *
 * DOM-native nodes (empty `moduleId`, has `tag`) store actual HTML structure
 * instead of module props. This component renders them as real React elements
 * with the same editor event handlers (selection, hover, click) as the
 * module-based NodeRenderer, so the canvas DOM matches the published DOM 1:1.
 *
 * Void elements (`br`, `img`, `input`, etc.) render without children or a
 * closing tag. Non-void elements render their children recursively via
 * `NodeRenderer`, or `textContent` when the node has no element children.
 */

import React, { memo, use, type CSSProperties, type ReactNode } from 'react'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { isDomNode, VOID_HTML_ELEMENTS } from '@core/page-tree'
import { bagToReactStyle } from '@core/publisher'
import { getCanvasNodeClassName } from './canvasNodeClassName'
import { CanvasBreakpointContext, CanvasSelectionContext } from './CanvasContexts'
import { findEnclosingComponentRef, type AnnotatedPageNode } from './canvasSelectionUtils'

interface DomNodeRendererProps {
  nodeId: string
  ChildRenderer: React.ComponentType<{ nodeId: string }>
}

export const DomNodeRenderer = memo(function DomNodeRenderer({ nodeId, ChildRenderer }: DomNodeRendererProps) {
  const node = useEditorStore((s) => selectActiveCanvasPage(s)?.nodes[nodeId] ?? null)
  const breakpointId = use(CanvasBreakpointContext)
  const { onNodeClick, onNodeHover, onNodeContextMenu, onNodeDoubleClick } = use(CanvasSelectionContext)

  const isSelected = useEditorStore((s) => s.selectedNodeIds.includes(nodeId))
  const isHovered = useEditorStore(
    (s) =>
      s.hoveredNodeId === nodeId &&
      (!s.hoveredBreakpointId || s.hoveredBreakpointId === breakpointId),
  )
  const mcClassName = useEditorStore((s) => {
    const canvasNode = selectActiveCanvasPage(s)?.nodes[nodeId]
    const preview = s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null
    return getCanvasNodeClassName(canvasNode?.classIds, preview, nodeId, s.site?.styleRules)
  })

  if (!node) return null
  if (node.hidden) return null
  if (!isDomNode(node)) return null

  const tag = node.tag!
  const inlineStyle = bagToReactStyle(node.inlineStyles)

  // Build className from classIds + any class in attributes
  const attrClass = node.attributes?.class
  const className = [mcClassName, attrClass].filter(Boolean).join(' ') || undefined

  // Build React props from node.attributes (excluding class, handled above)
  const attrProps: Record<string, string> = {}
  if (node.attributes) {
    for (const [key, value] of Object.entries(node.attributes)) {
      if (key === 'class') continue
      attrProps[key] = value
    }
  }

  const editorProps = {
    'data-node-id': nodeId,
    'data-module-id': '',
    tabIndex: 0,
    ...(className ? { className } : {}),
    ...(inlineStyle ? { style: inlineStyle as CSSProperties } : {}),
    ...(isSelected ? { 'data-canvas-selected': 'true' as const } : {}),
    ...(isHovered && !isSelected ? { 'data-hovered': 'true' as const } : {}),
    onClickCapture: (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      handleCanvasClick(nodeId, e, breakpointId ?? '', onNodeClick)
    },
    onContextMenuCapture: (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onNodeContextMenu(nodeId, e, breakpointId ?? '')
    },
    onDoubleClickCapture: (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onNodeDoubleClick(nodeId, e, breakpointId ?? '')
    },
    onMouseEnter: () => onNodeHover(nodeId, breakpointId ?? ''),
    onMouseLeave: () => onNodeHover(null, breakpointId ?? ''),
  }

  // Void elements: no children, no closing tag
  if (VOID_HTML_ELEMENTS.has(tag)) {
    return React.createElement(tag, { ...attrProps, ...editorProps })
  }

  // Render children or textContent
  const hasChildren = (node.children ?? []).length > 0
  const children: ReactNode = hasChildren
    ? node.children.map((childId) => <ChildRenderer key={childId} nodeId={childId} />)
    : (node.textContent ?? undefined)

  return React.createElement(tag, { ...attrProps, ...editorProps }, children)
})

// --- Helpers ---

function handleCanvasClick(
  nodeId: string,
  e: React.MouseEvent,
  breakpointId: string,
  onNodeClick: (nodeId: string, e: React.MouseEvent, breakpointId: string) => void,
) {
  // B3 — VC lock-down: redirect clicks inside inlined VC bodies to the ref node.
  const state = useEditorStore.getState()
  if (state.activeDocument?.kind !== 'visualComponent') {
    const page = selectActiveCanvasPage(state)
    if (page) {
      const enclosing = findEnclosingComponentRef(
        page.nodes as Record<string, AnnotatedPageNode>,
        nodeId,
      )
      if (enclosing !== null && !enclosing.isInsideSlotContent) {
        onNodeClick(enclosing.refId, e, breakpointId)
        return
      }
    }
  }
  onNodeClick(nodeId, e, breakpointId)
}
