/**
 * ColorsPanelBody — the Colors tab body inside the consolidated Framework
 * panel. Chrome-free: it owns no `<Panel>` shell or open-state (the
 * FrameworkPanel provides those). Manages framework color tokens: filter +
 * search, per-token cards, create dialog, and the per-token context menu.
 */
import { useState, type MouseEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { FrameworkColorToken } from '@core/framework-schema'
import type { UpdateFrameworkColorTokenPatch } from '@site/store/slices/site/types'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { FilterBar, type FilterBarItem } from '@ui/components/FilterBar'
import { FilePlusSolidIcon } from 'pixel-art-icons/icons/file-plus-solid'
import { useFrameworkChangeConfirm } from '@admin/shared/dialogs/FrameworkChangeConfirmDialog'
import { applyColorTokenPatchPreview } from '@site/store/slices/site/framework/colors'
import { ColorTokenCard } from './ColorTokenCard'
import { ColorTokenContextMenu } from './ColorTokenContextMenu'
import { CreateColorDialog } from './CreateColorDialog'
import {
  EMPTY_COLORS,
  canMoveToken,
  deriveCategoryLabels,
  deriveColorPatchActionLabel,
} from './helpers'
import styles from './ColorsPanel.module.css'

interface TokenContextMenuState {
  x: number
  y: number
  tokenId: string
}

export function ColorsPanelBody() {
  const site = useEditorStore((s) => s.site)
  const createFrameworkColorToken = useEditorStore((s) => s.createFrameworkColorToken)
  const updateFrameworkColorToken = useEditorStore((s) => s.updateFrameworkColorToken)
  const duplicateFrameworkColorToken = useEditorStore((s) => s.duplicateFrameworkColorToken)
  const reorderFrameworkColorToken = useEditorStore((s) => s.reorderFrameworkColorToken)
  const deleteFrameworkColorToken = useEditorStore((s) => s.deleteFrameworkColorToken)
  const confirmFrameworkChange = useFrameworkChangeConfirm()

  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [expandedTokenId, setExpandedTokenId] = useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<TokenContextMenuState | null>(null)

  const colors = site?.settings.framework?.colors ?? EMPTY_COLORS
  const categories = deriveCategoryLabels(colors.tokens)

  // Derive the effective filter without mutating state during render — avoids
  // the double-render that a guard + setState would cause. When the active
  // category's last token is removed, the derived value collapses to null
  // automatically without any setState call.
  const effectiveActiveCategory =
    activeCategory !== null && categories.includes(activeCategory) ? activeCategory : null

  // Group the list by category (same order as the filter chips), then by the
  // intra-category `order`. This matches how reordering works — move up / down
  // swaps a token only with its category siblings — so categories always render
  // as contiguous blocks and a re-imported token slots in with its group
  // instead of trailing at the end of a flat order-sorted list.
  const categoryRank = new Map(categories.map((label, index) => [label, index]))
  const normalizedQuery = query.trim().toLowerCase()
  const filteredTokens = colors.tokens
    .filter(
      (token) => effectiveActiveCategory === null || token.category === effectiveActiveCategory,
    )
    .filter((token) => !normalizedQuery || token.slug.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      const rankA = categoryRank.get(a.category) ?? categories.length
      const rankB = categoryRank.get(b.category) ?? categories.length
      if (rankA !== rankB) return rankA - rankB
      return a.order - b.order || a.slug.localeCompare(b.slug)
    })

  const contextToken = contextMenu
    ? (colors.tokens.find((token) => token.id === contextMenu.tokenId) ?? null)
    : null

  function handleCreate(name: string, lightValue: string, category: string) {
    const token = createFrameworkColorToken({
      slug: name,
      lightValue,
      category,
      darkModeEnabled: false,
    })
    setExpandedTokenId(token.id)
    setCreateDialogOpen(false)
  }

  function openTokenContextMenu(tokenId: string, event: MouseEvent<HTMLElement>) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY, tokenId })
  }

  function handleDuplicateToken(token: FrameworkColorToken) {
    const copy = duplicateFrameworkColorToken(token.id)
    if (copy) setExpandedTokenId(copy.id)
    setContextMenu(null)
  }

  function handleMoveToken(token: FrameworkColorToken, direction: 'up' | 'down') {
    reorderFrameworkColorToken(token.id, direction)
    setContextMenu(null)
  }

  function handleDeleteToken(token: FrameworkColorToken) {
    setContextMenu(null)
    confirmFrameworkChange({
      actionLabel: `Delete token "${token.slug}"`,
      applyChange: (draft) => {
        const draftColors = draft.settings.framework?.colors
        if (!draftColors) return
        draftColors.tokens = draftColors.tokens.filter((t) => t.id !== token.id)
      },
      commit: () => {
        deleteFrameworkColorToken(token.id)
        if (expandedTokenId === token.id) setExpandedTokenId(null)
      },
    })
  }

  function handlePatchToken(token: FrameworkColorToken, patch: UpdateFrameworkColorTokenPatch) {
    confirmFrameworkChange({
      actionLabel: deriveColorPatchActionLabel(patch, token),
      applyChange: (draft) => applyColorTokenPatchPreview(draft, token.id, patch),
      commit: () => updateFrameworkColorToken(token.id, patch),
    })
  }

  return (
    <>
      <FilterBar<string | null>
        items={[
          { value: null, label: 'All' },
          ...categories.map<FilterBarItem<string | null>>((category) => ({
            value: category,
            label: category,
          })),
        ]}
        value={effectiveActiveCategory}
        onValueChange={setActiveCategory}
        search={{
          value: query,
          onValueChange: setQuery,
          onClear: () => setQuery(''),
          placeholder: 'Search colors',
          ariaLabel: 'Search colors',
        }}
        searchTrailing={
          <Button
            variant="secondary"
            size="sm"
            iconOnly
            aria-label="Create color"
            tooltip="Create color"
            onClick={() => setCreateDialogOpen(true)}
          >
            <FilePlusSolidIcon size={13} aria-hidden="true" />
          </Button>
        }
        groupLabel="Color categories"
      />

      {colors.tokens.length === 0 ? (
        <EmptyState
          title="No colors yet."
          action={
            <Button variant="secondary" size="sm" onClick={() => setCreateDialogOpen(true)}>
              Create color
            </Button>
          }
        />
      ) : filteredTokens.length === 0 ? (
        <EmptyState title="No colors match the current filters." />
      ) : (
        <div className={styles.rows}>
          {filteredTokens.map((token) => (
            <ColorTokenCard
              key={token.id}
              token={token}
              categories={categories}
              expanded={expandedTokenId === token.id}
              onToggle={() =>
                setExpandedTokenId(expandedTokenId === token.id ? null : token.id)
              }
              onPatch={(patch) => handlePatchToken(token, patch)}
              onContextMenu={(event) => openTokenContextMenu(token.id, event)}
            />
          ))}
        </div>
      )}

      {createDialogOpen && (
        <CreateColorDialog
          categories={categories}
          defaultCategory={effectiveActiveCategory ?? ''}
          onCancel={() => setCreateDialogOpen(false)}
          onSubmit={handleCreate}
        />
      )}
      {contextMenu && contextToken && (
        <ColorTokenContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canMoveUp={canMoveToken(colors.tokens, contextToken, 'up')}
          canMoveDown={canMoveToken(colors.tokens, contextToken, 'down')}
          onClose={() => setContextMenu(null)}
          onDuplicate={() => handleDuplicateToken(contextToken)}
          onMoveUp={() => handleMoveToken(contextToken, 'up')}
          onMoveDown={() => handleMoveToken(contextToken, 'down')}
          onDelete={() => handleDeleteToken(contextToken)}
        />
      )}
    </>
  )
}
