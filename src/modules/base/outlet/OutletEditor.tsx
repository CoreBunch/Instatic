/**
 * base.outlet editor preview component.
 *
 * The outlet renders read-only inside the canvas as the author-chosen tag
 * (default `<main>`), carrying the editor wrapper bag so it has a single
 * selection overlay — the outlet itself is what the author selects, never the
 * matched content inside it.
 *
 * What flows into the region, in priority order:
 *   1. `props.html` — a postTypes template resolves the current entry's body
 *      into this prop via the outlet's `{currentEntry.body}` binding (against
 *      the synthetic preview row). Rendered as read-only HTML.
 *   2. The first non-template page — an `everywhere` template hosts whole pages,
 *      so we preview the first matching page's tree read-only via
 *      `ReadOnlyNodeTree`, the same renderer used for inlined VC bodies.
 *   3. Neither available — the shared empty-state placeholder.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { useEditorStore, selectActivePage } from '@site/store/store'
import { isTemplatePage } from '@core/templates'
import type { BaseNode } from '@core/page-tree'
import { resolveHtmlTag } from '@core/htmlAttributes'
import { ReadOnlyNodeTree } from '@modules/base/utils/ReadOnlyNodeTree'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { TextPlusIcon } from 'pixel-art-icons/icons/text-plus'
import type { OutletStoredProps } from './props'

export const OutletEditor: React.FC<ModuleComponentProps<OutletStoredProps>> = ({
  props,
  mcClassName,
  nodeWrapperProps,
}) => {
  const tag = resolveHtmlTag(props.tag, props.customTag)

  const styleRules = useEditorStore((s) => s.site?.styleRules ?? null)
  // The page an `everywhere` template's outlet hosts — the first non-template
  // page in document order. Null for postTypes / non-template / page-less sites.
  const previewPage = useEditorStore((s) => {
    if (!s.site) return null
    const active = selectActivePage(s)
    if (active?.template?.target?.kind !== 'everywhere') return null
    // The page the author picked to preview (TemplateModeControl), or the
    // first non-template page. Session-only selection, keyed by template id.
    const selectedId = s.templatePreviewSelection[active.id]
    const selected = selectedId
      ? s.site.pages.find((p) => p.id === selectedId && !isTemplatePage(p))
      : null
    return selected ?? s.site.pages.find((p) => !isTemplatePage(p)) ?? null
  })

  const html = typeof props.html === 'string' ? props.html : ''

  // (1) postTypes entry body, resolved into props.html via the binding.
  if (html) {
    return React.createElement(tag, {
      ...nodeWrapperProps,
      className: mcClassName || undefined,
      'data-instatic-content-region': '',
      dangerouslySetInnerHTML: { __html: html },
    })
  }

  // (2) everywhere → first matching page, or (3) placeholder.
  const inner = previewPage ? (
    <ReadOnlyNodeTree
      nodes={previewPage.nodes as Record<string, BaseNode>}
      rootNodeId={previewPage.rootNodeId}
      classes={styleRules}
      readonly={{ label: `${previewPage.title} (outlet preview)`, kind: 'page', targetId: previewPage.id }}
    />
  ) : (
    <CanvasModulePlaceholder icon={<TextPlusIcon size={16} />} label="Content outlet" />
  )

  return React.createElement(
    tag,
    {
      ...nodeWrapperProps,
      className: mcClassName || undefined,
      'data-instatic-content-region': '',
    },
    inner,
  )
}
