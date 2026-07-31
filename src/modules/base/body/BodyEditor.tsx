/**
 * base.body editor preview component.
 *
 * Renders ONLY its children — no wrapper element. The page-tree children
 * render directly into the iframe's real `<body>`, matching what the
 * publisher does (the publisher's `base.body` also emits no wrapper; the
 * body element is the published document's `<body>`).
 *
 * Editor metadata that used to live on a wrapping `<div>` (data-node-id,
 * canvas selection attrs, click handlers, the user's mcClassName) is now
 * applied to the iframe's actual `<body>` element via the document context
 * supplied by `IframeFrameSurface`. No editor-only probe is inserted into the
 * body, so authored child/sibling selectors see the published DOM exactly.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 */
import { use, useEffect } from 'react'
import type { ModuleComponentProps, NodeWrapperProps as NodeWrapperPropsType } from '@core/module-engine'
import { applyIframeBodyPresentation } from '@site/canvas/iframeBodyPresentation'
import { htmlAttributesForReact } from '@modules/base/shared/htmlAttributes'
import { CanvasDocumentContext } from '@site/canvas/CanvasContexts'

type BodyProps = { htmlAttributes?: unknown }

export const BodyEditor = ({
  children,
  mcClassName,
  nodeWrapperProps,
  props,
}: ModuleComponentProps<BodyProps>) => {
  const iframeDocument = use(CanvasDocumentContext)

  useEffect(() => {
    const body = iframeDocument?.body
    if (!body) return
    return applyEditorAttrsToBody(
      body,
      mcClassName,
      nodeWrapperProps,
      htmlAttributesForReact(props.htmlAttributes),
    )
  }, [iframeDocument, mcClassName, nodeWrapperProps, props.htmlAttributes])

  return children
}

/**
 * Apply editor attrs/handlers from `nodeWrapperProps` onto the iframe
 * `<body>` and return a cleanup that removes the handlers. Lives at module
 * scope so React Compiler doesn't flag the cross-frame DOM mutations.
 */
function applyEditorAttrsToBody(
  body: HTMLElement,
  mcClassName: string | undefined,
  nodeWrapperProps: NodeWrapperPropsType | undefined,
  htmlAttributes: Record<string, string>,
): () => void {
  const restorePresentation = applyIframeBodyPresentation(body, {
    className: mcClassName,
    style: nodeWrapperProps?.style,
    attributes: htmlAttributes,
  })
  const restoreEditorAttributes = snapshotBodyAttributes(body, [
    'data-node-id',
    'data-module-id',
    'tabindex',
    'data-canvas-selected',
    'data-hovered',
  ])

  if (nodeWrapperProps?.['data-node-id']) {
    body.setAttribute('data-node-id', nodeWrapperProps['data-node-id'])
  }
  if (nodeWrapperProps?.['data-module-id']) {
    body.setAttribute('data-module-id', nodeWrapperProps['data-module-id'])
  }
  body.setAttribute('tabindex', '0')
  if (nodeWrapperProps?.['data-canvas-selected']) {
    body.setAttribute('data-canvas-selected', nodeWrapperProps['data-canvas-selected'])
  } else {
    body.removeAttribute('data-canvas-selected')
  }
  if (nodeWrapperProps?.['data-hovered']) {
    body.setAttribute('data-hovered', nodeWrapperProps['data-hovered'])
  } else {
    body.removeAttribute('data-hovered')
  }
  const handlers: Array<[string, EventListener]> = []
  const addListener = <K extends keyof HTMLElementEventMap>(
    name: K,
    handler: ((e: HTMLElementEventMap[K]) => void) | undefined,
  ) => {
    if (!handler) return
    const wrapped = handler as unknown as EventListener
    body.addEventListener(name, wrapped)
    handlers.push([name, wrapped])
  }
  addListener('click', nodeWrapperProps?.onClick as unknown as ((e: MouseEvent) => void) | undefined)
  addListener('dblclick', nodeWrapperProps?.onDoubleClick as unknown as ((e: MouseEvent) => void) | undefined)
  addListener('contextmenu', nodeWrapperProps?.onContextMenu as unknown as ((e: MouseEvent) => void) | undefined)
  addListener('keydown', nodeWrapperProps?.onKeyDown as unknown as ((e: KeyboardEvent) => void) | undefined)
  const onMouseEnter = nodeWrapperProps?.onMouseEnter
  if (onMouseEnter) {
    const wrapped = () => onMouseEnter()
    body.addEventListener('mouseenter', wrapped)
    handlers.push(['mouseenter', wrapped as EventListener])
  }
  const onMouseLeave = nodeWrapperProps?.onMouseLeave
  if (onMouseLeave) {
    const wrapped = () => onMouseLeave()
    body.addEventListener('mouseleave', wrapped)
    handlers.push(['mouseleave', wrapped as EventListener])
  }

  return () => {
    for (const [name, handler] of handlers) {
      body.removeEventListener(name, handler)
    }
    restoreEditorAttributes()
    restorePresentation()
  }
}

function snapshotBodyAttributes(body: HTMLElement, names: string[]): () => void {
  const previous = names.map((name) => ({ name, value: body.getAttribute(name) }))
  return () => {
    for (const attribute of previous) {
      if (attribute.value === null) body.removeAttribute(attribute.name)
      else body.setAttribute(attribute.name, attribute.value)
    }
  }
}
