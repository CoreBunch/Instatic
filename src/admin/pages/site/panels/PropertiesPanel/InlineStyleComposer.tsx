/**
 * InlineStyleComposer — CSS section editor bound to a node's inline styles.
 *
 * The sibling of `StyleRuleComposer`: same `StyleSectionsEditor` rendering core,
 * but reads from / writes to `node.inlineStyles` (the per-node `style=""`
 * layer the publisher emits) instead of a StyleRule.
 *
 * Inline styles are BASE-ONLY — a real HTML `style=""` attribute cannot be
 * media-queried — so this editor ignores the breakpoint / condition switcher
 * entirely and always edits the single inline bag (sectionKey `'base'`). The
 * canvas hover-preview channel is class-keyed, so preview is a no-op here.
 */

import { useEditorStore } from '@site/store/store'
import type { CSSPropertyBag } from '@core/page-tree'
import { StyleSectionsEditor } from './StyleSectionsEditor'

/** Stable empty bag for nodes with no inline styles (avoids a fresh object per render). */
const EMPTY_STYLES: Record<string, unknown> = {}

interface InlineStyleComposerProps {
  nodeId: string
  /** The node's current inline styles (re-read from the store on every change). */
  inlineStyles: Record<string, unknown> | undefined
  /** Search query — filters visible properties across all categories. */
  styleQuery: string
}

export function InlineStyleComposer({ nodeId, inlineStyles, styleQuery }: InlineStyleComposerProps) {
  const setNodeInlineStyles = useEditorStore((s) => s.setNodeInlineStyles)
  const removeNodeInlineStyleProperty = useEditorStore((s) => s.removeNodeInlineStyleProperty)

  const stored: Record<string, unknown> = inlineStyles ?? EMPTY_STYLES

  const handleChange = (key: keyof CSSPropertyBag, value: string | number | undefined) => {
    setNodeInlineStyles(nodeId, { [String(key)]: value ?? null })
  }
  // Several properties in one commit — see StyleRuleComposer.handleChangeMany.
  const handleChangeMany = (patch: Partial<CSSPropertyBag>) => {
    setNodeInlineStyles(
      nodeId,
      Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? null])),
    )
  }
  const handleRemove = (key: keyof CSSPropertyBag) => {
    removeNodeInlineStyleProperty(nodeId, String(key))
  }
  // Clear several properties in one undo step (e.g. display + its flex/grid deps).
  const handleClearProperties = (keys: ReadonlyArray<keyof CSSPropertyBag>) => {
    setNodeInlineStyles(nodeId, Object.fromEntries(keys.map((k) => [String(k), null])))
  }

  return (
    <StyleSectionsEditor
      // Inline styles have no context axis; the single bag is both stored and current.
      storedStyles={stored}
      currentStyles={stored}
      sectionKey="base"
      styleQuery={styleQuery}
      onChange={handleChange}
      onChangeMany={handleChangeMany}
      onRemove={handleRemove}
      onClearProperty={handleRemove}
      onClearProperties={handleClearProperties}
      // Hover-preview is class-keyed in the store; skip it for inline editing.
      onPreview={noop}
      onClearPreview={noop}
    />
  )
}

function noop() {}
