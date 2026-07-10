/**
 * DomNodeProperties — Properties Panel content for DOM-native nodes.
 *
 * DOM-native nodes (empty `moduleId`, has `tag`) store actual HTML structure
 * instead of module props. This component provides editors for:
 *   - Tag name (text input with common HTML tag suggestions)
 *   - Attributes (key-value pair editor — add/edit/remove)
 *   - Text content (text area, only for leaf nodes without element children)
 *
 * Inline styles and class assignment are handled by the shared StyleSurface
 * sections that wrap this content — same as module-based nodes.
 */

import { useCallback, useState } from 'react'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { isDomNode, VOID_HTML_ELEMENTS } from '@core/page-tree'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import styles from './DomNodeProperties.module.css'

interface DomNodePropertiesProps {
  nodeId: string
}

export function DomNodeProperties({ nodeId }: DomNodePropertiesProps) {
  const node = useEditorStore((s) => selectActiveCanvasPage(s)?.nodes[nodeId] ?? null)
  const updateDomNode = useEditorStore((s) => s.updateDomNode)

  const [newAttrKey, setNewAttrKey] = useState('')
  const [newAttrValue, setNewAttrValue] = useState('')

  const handleAddAttribute = useCallback(() => {
    const key = newAttrKey.trim()
    if (!key) return
    updateDomNode(nodeId, {
      attributes: { [key]: newAttrValue },
    })
    setNewAttrKey('')
    setNewAttrValue('')
  }, [nodeId, newAttrKey, newAttrValue, updateDomNode])

  const handleRemoveAttribute = useCallback((key: string) => {
    updateDomNode(nodeId, {
      attributes: { [key]: null as unknown as string },
    })
  }, [nodeId, updateDomNode])

  const handleAttributeChange = useCallback((key: string, value: string) => {
    updateDomNode(nodeId, {
      attributes: { [key]: value },
    })
  }, [nodeId, updateDomNode])

  if (!node || !isDomNode(node)) return null

  const tag = node.tag!
  const isVoid = VOID_HTML_ELEMENTS.has(tag)
  const hasElementChildren = (node.children ?? []).length > 0
  const canHaveTextContent = !isVoid && !hasElementChildren

  return (
    <div className={styles.container}>
      {/* Tag */}
      <div className={styles.field}>
        <label className={styles.label}>Tag</label>
        <Input
          fieldSize="sm"
          value={tag}
          onChange={(e) => updateDomNode(nodeId, { tag: e.target.value.toLowerCase() })}
          placeholder="div"
          data-testid="dom-node-tag-input"
        />
      </div>

      {/* Text content — only for non-void leaf nodes */}
      {canHaveTextContent && (
        <div className={styles.field}>
          <label className={styles.label}>Text content</label>
          <textarea
            className={styles.textarea}
            value={node.textContent ?? ''}
            onChange={(e) => updateDomNode(nodeId, { textContent: e.target.value })}
            placeholder="Enter text…"
            rows={3}
            data-testid="dom-node-text-input"
          />
        </div>
      )}

      {/* Attributes */}
      <div className={styles.field}>
        <label className={styles.label}>Attributes</label>
        <div className={styles.attrList}>
          {node.attributes &&
            Object.entries(node.attributes).map(([key, value]) => (
              <div key={key} className={styles.attrRow}>
                <Input
                  fieldSize="xs"
                  value={key}
                  readOnly
                  className={styles.attrKey}
                />
                <Input
                  fieldSize="xs"
                  value={value}
                  onChange={(e) => handleAttributeChange(key, e.target.value)}
                  className={styles.attrValue}
                />
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => handleRemoveAttribute(key)}
                  aria-label={`Remove attribute ${key}`}
                  className={styles.attrRemove}
                >
                  <TrashSolidIcon size={13} />
                </Button>
              </div>
            ))}
          <div className={styles.attrRow}>
            <Input
              fieldSize="xs"
              value={newAttrKey}
              onChange={(e) => setNewAttrKey(e.target.value)}
              placeholder="key"
              className={styles.attrKey}
              data-testid="dom-node-attr-key-input"
            />
            <Input
              fieldSize="xs"
              value={newAttrValue}
              onChange={(e) => setNewAttrValue(e.target.value)}
              placeholder="value"
              className={styles.attrValue}
              data-testid="dom-node-attr-value-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddAttribute()
              }}
            />
            <Button
              variant="ghost"
              size="xs"
              onClick={handleAddAttribute}
              aria-label="Add attribute"
              className={styles.attrAdd}
              data-testid="dom-node-attr-add-btn"
            >
              <PlusIcon size={13} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
