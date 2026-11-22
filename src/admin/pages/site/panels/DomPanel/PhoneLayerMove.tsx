import { useState } from 'react'
import { registry } from '@core/module-engine'
import { getNodeDisplayName, getNodeHtmlTag, getParent, resolvePageTreeDropTarget, type Page } from '@core/page-tree'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { revealSelectedCanvasNode } from '@site/canvas/revealSelectedCanvasNode'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { SearchBar } from '@ui/components/SearchBar'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { TagPill } from '@ui/components/TagPill'
import { layerTextPreview } from './layerTextPreview'
import styles from './PhoneLayerMove.module.css'

type Position = 'before' | 'after'

/** Reorder within one parent; use the same validity and index rules as dragging. */
function siblingTarget(page: Page, source: string, destination: string, position: Position) {
  if (page.nodes[source]?.parentId !== page.nodes[destination]?.parentId) return null
  return resolvePageTreeDropTarget({
    tree: page, draggedId: source, overId: destination, zone: position,
    canHaveChildren: (moduleId) => registry.get(moduleId)?.canHaveChildren === true,
  })
}

export function PhoneLayerMove({ page, nodeId }: { page: Page; nodeId: string }) {
  const components = useEditorStore((s) => s.site?.visualComponents)
  const [position, setPosition] = useState<Position | null>(null)
  const [query, setQuery] = useState('')
  const source = page.nodes[nodeId]
  const parent = getParent(page, nodeId)
  if (!source || source.locked || !parent || parent.locked ||
      parent.moduleId === 'base.visual-component-ref' || parent.children.length < 2) return null

  function move(destination: string) {
    const state = useEditorStore.getState()
    const current = selectActiveCanvasPage(state)
    if (!current || !position || state.selectedNodeId !== nodeId) return
    const target = siblingTarget(current, nodeId, destination, position)
    if (!target) return
    state.moveNode(nodeId, target.parentId, target.index)
    state.selectNode(nodeId, 'replace', { propertiesPanel: 'close' })
    setPosition(null)
    state.setExplorerPanelOpen(false)
    requestAnimationFrame(() => revealSelectedCanvasNode(nodeId))
  }

  const name = getNodeDisplayName(source, registry.get(source.moduleId), components)
  const needle = query.trim().toLowerCase()
  // The adjacent sibling on the chosen side is already in that position.
  const index = parent.children.indexOf(nodeId)
  const unchanged = parent.children[index + (position === 'before' ? 1 : -1)]
  const destinations = position ? parent.children.flatMap((id) => {
    const node = page.nodes[id]
    if (!node || id === nodeId) return []
    const definition = registry.get(node.moduleId)
    const label = getNodeDisplayName(node, definition, components)
    const text = layerTextPreview(node)
    const tag = getNodeHtmlTag(node, definition)
    if (!`${label} ${text} ${tag ?? ''}`.toLowerCase().includes(needle)) return []
    return [{ id, title: node.label || text || label, tag, enabled: id !== unchanged }]
  }) : []

  return (
    <>
      <Button variant="secondary" size="lg" onClick={() => {
        setQuery('')
        setPosition(parent.children[0] === nodeId ? 'after' : 'before')
      }}>Move</Button>
      {position && (
        <Dialog open title="Move layer" onClose={() => setPosition(null)} bodyClassName={styles.body}>
          <p className={styles.source}>{source.label || layerTextPreview(source) || name}</p>
          <SegmentedControl<Position>
            fullWidth size="lg" value={position} onChange={setPosition} aria-label="Placement"
            options={[{ value: 'before', label: 'Place before' }, { value: 'after', label: 'Place after' }]}
          />
          <SearchBar value={query} onValueChange={setQuery} aria-label="Find a destination" placeholder="Find a destination…" className={styles.search} />
          <div className={styles.destinations} aria-label="Destination layers" role="group">
            {destinations.map(({ id, title, tag, enabled }) => (
              <Button key={id} size="lg" variant="secondary" align="start" disabled={!enabled}
                aria-label={`Move ${position} ${title}`} onClick={() => move(id)}>
                {tag && <TagPill label={tag} size="xs" monospace aria-hidden="true" />}
                <span className={styles.label}>{title}</span>
              </Button>
            ))}
            {destinations.length === 0 && <p>No matching layers</p>}
          </div>
        </Dialog>
      )}
    </>
  )
}
