/**
 * CanvasComposedTree — render the active document the way it publishes: inside
 * its matching template chain.
 *
 * When the document being edited is wrapped by one or more templates (an
 * `everywhere` layout around a page or a postTypes template), those wrappers
 * render READ-ONLY around the editable document via `ReadOnlyNodeTree`, with the
 * editable document spliced into the innermost wrapper's `base.outlet` — exactly
 * where the publisher would splice it. The wrapper chrome (nav, footer, …) is
 * pixel-identical to the published page but non-interactive; only the active
 * document's own nodes stay fully editable (selection, hover, DnD), so every
 * existing editor subsystem keeps operating on the unchanged active-page tree.
 *
 * Body ownership mirrors the publisher: the published `<body>` is the OUTERMOST
 * wrapper's body element (the inner document's `base.body` is dropped and its
 * children spliced in — inner body classes are not preserved). So in the wrapped
 * case we apply the outermost wrapper body's classes, inline styles, and safe
 * HTML attributes to the iframe `<body>` and render the active document as its
 * body CHILDREN, rather than letting the inner body claim presentation the
 * published page would not carry.
 *
 * When nothing wraps the document (editing the `everywhere` layout itself, or a
 * site with no matching template), it renders exactly as before — a plain
 * `NodeRenderer` at the document root, whose `base.body` claims the iframe body
 * as usual. Its own outlet, if any, still previews matched content through
 * `OutletEditor`.
 */

import { use, useEffect, type ReactNode } from 'react'
import type { BaseNode, Page } from '@core/page-tree'
import { classNamesForClassIds } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { ReadOnlyNodeTree } from '@modules/base/utils/ReadOnlyNodeTree'
import { htmlAttributesForReact } from '@modules/base/shared/htmlAttributes'
import { useResponsiveBackgroundStyle } from '@admin/pages/media/hooks/useResponsiveBackgroundStyle'
import { NodeRenderer } from './NodeRenderer'
import { resolveEditorWrapperTemplates } from './canvasComposition'
import { CanvasDocumentContext, CanvasTemplateContext } from './CanvasContexts'
import { applyIframeBodyPresentation } from './iframeBodyPresentation'

const NO_WRAPPERS: Page[] = []

interface CanvasComposedTreeProps {
  /** The active document being edited (the editable page / template). */
  page: Page
}

export function CanvasComposedTree({ page }: CanvasComposedTreeProps) {
  const site = useEditorStore((s) => s.site)
  const isVcMode = useEditorStore((s) => s.activeDocument?.kind === 'visualComponent')
  const styleRules = useEditorStore((s) => s.site?.styleRules ?? null)
  const templateContext = use(CanvasTemplateContext)

  // Templates wrapping the active document (outermost-first). A Visual
  // Component edit surface is never a published route, so it is never wrapped.
  const wrappers = !isVcMode && site ? resolveEditorWrapperTemplates(site, page) : NO_WRAPPERS
  const outerBody = wrappers[0]?.nodes[wrappers[0].rootNodeId]

  // No wrapping templates → render the document exactly as before; its own
  // base.body claims the iframe <body>.
  if (wrappers.length === 0) {
    return <NodeRenderer nodeId={page.rootNodeId} />
  }

  // Editable content = the active document's body children, rendered editable.
  // The active document's base.body is intentionally NOT rendered here — it is
  // dropped just as the publisher drops the inner body when splicing.
  const bodyNode = page.nodes[page.rootNodeId]
  const editableContent = bodyNode
    ? bodyNode.children.map((childId) => <NodeRenderer key={childId} nodeId={childId} />)
    : null

  // Nest the read-only wrappers from innermost outward; each wrapper's outlet
  // hosts the next inner layer, the innermost hosting the editable content.
  let composed: ReactNode = <>{editableContent}</>
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const wrapper = wrappers[i]
    composed = (
      <ReadOnlyNodeTree
        nodes={wrapper.nodes as Record<string, BaseNode>}
        rootNodeId={wrapper.rootNodeId}
        classes={styleRules}
        outletSlot={composed}
        readonly={{ label: `${wrapper.title} template`, kind: 'page', targetId: wrapper.id }}
        templateContext={templateContext}
      />
    )
  }

  // Mirror the outermost wrapper body's classes + inline styles onto the
  // iframe <body>, exactly as the published document would carry them.
  const bodyClassName = outerBody
    ? classNamesForClassIds(styleRules, outerBody.classIds).join(' ')
    : ''

  return (
    <>
      <IframeBodyPresentationOwner
        className={bodyClassName}
        inlineStyles={outerBody?.inlineStyles}
        htmlAttributes={outerBody?.props.htmlAttributes}
      />
      {composed}
    </>
  )
}

/**
 * Apply the outer body's presentation to the host iframe's `<body>` while
 * mounted (and restore it on unmount). The frame supplies its final srcDoc
 * through context, so this owner contributes no editor-only body child. Only
 * used in the wrapped case, where no `base.body` editor runs to own the body.
 */
function IframeBodyPresentationOwner({
  className,
  inlineStyles,
  htmlAttributes,
}: {
  className: string
  inlineStyles?: BaseNode['inlineStyles']
  htmlAttributes?: unknown
}) {
  const iframeDocument = use(CanvasDocumentContext)
  const style = useResponsiveBackgroundStyle(inlineStyles)
  useEffect(() => {
    const body = iframeDocument?.body
    if (!body) return
    return applyIframeBodyPresentation(body, {
      className,
      style,
      attributes: htmlAttributesForReact(htmlAttributes),
    })
  }, [className, htmlAttributes, iframeDocument, style])
  return null
}
