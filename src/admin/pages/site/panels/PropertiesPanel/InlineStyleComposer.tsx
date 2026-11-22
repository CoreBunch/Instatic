/**
 * InlineStyleComposer — CSS section editor bound to a node's inline styles.
 *
 * The sibling of `StyleRuleComposer`: same `StyleSectionsEditor` rendering core,
 * but reads from / writes to `node.inlineStyles` (the per-node `style=""`
 * layer the publisher emits) instead of a StyleRule.
 *
 * Inline styles are BASE-ONLY — a real HTML `style=""` attribute cannot be
 * media-queried — so this editor ignores the breakpoint / condition switcher
 * entirely and always edits the single inline bag (sectionKey `'base'`).
 */

import { useEffect } from 'react'
import { inlineStyleTarget } from '@site/store/useActiveStyleTarget'
import { useEditorStore } from '@site/store/store'
import type { CSSPropertyBag } from '@core/page-tree'
import { StyleSectionsEditor } from './StyleSectionsEditor'

interface InlineStyleComposerProps {
  nodeId: string
  /** The node's current inline styles (re-read from the store on every change). */
  inlineStyles: Record<string, unknown> | undefined
  /** Search query — filters visible properties across all categories. */
  textElement?: boolean
  styleQuery: string
}

export function InlineStyleComposer({ nodeId, inlineStyles, styleQuery, textElement }: InlineStyleComposerProps) {
  const target = inlineStyleTarget(nodeId, inlineStyles)
  useEffect(() => () => useEditorStore.getState().setPreviewInlineStyles(nodeId, null), [nodeId])

  const handleChange = (key: keyof CSSPropertyBag, value: string | number | undefined) =>
    target.writeStyles({ [key]: value })
  const handleRemove = (key: keyof CSSPropertyBag) => handleChange(key, undefined)

  return (
    <StyleSectionsEditor
      // Inline styles have no context axis; the single bag is both stored and current.
      textElement={textElement}
      storedStyles={target.styles}
      currentStyles={target.styles}
      sectionKey="base"
      styleQuery={styleQuery}
      onChange={handleChange}
      onChangeMany={target.writeStyles}
      onRemove={handleRemove}
      onClearProperty={handleRemove}
      onClearProperties={(keys) => target.writeStyles(Object.fromEntries(keys.map((key) => [key, undefined])))}
      onPreview={target.previewStyles}
      onClearPreview={target.clearPreview}
    />
  )
}
