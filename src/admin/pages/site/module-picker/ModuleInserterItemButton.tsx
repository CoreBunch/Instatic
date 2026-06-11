import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import type { IconComponent } from 'pixel-art-icons/types'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { HandGrabSolidIcon } from 'pixel-art-icons/icons/hand-grab-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { StarSolidIcon } from 'pixel-art-icons/icons/star-solid'
import { ModuleIcon } from '@site/ui/ModuleIcon'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import {
  itemDescription,
  type ModuleInserterAccent,
  type ModuleInserterItem,
  type ModuleInserterSectionId,
} from './moduleInserterModel'
import { ModuleWireframe } from './ModuleWireframe'
import styles from './ModuleInserterDialog.module.css'

export type InserterView = 'grid' | 'list'

export interface SectionDefinition {
  id: ModuleInserterSectionId
  name: string
  accent: ModuleInserterAccent
  icon: IconComponent
}

interface InserterItemButtonProps {
  item: ModuleInserterItem
  view: InserterView
  selected: boolean
  onSelect: () => void
  onPick: () => void
  favorite: boolean
  onToggleFavorite: () => void
  onPointerDown: (
    item: ModuleInserterItem,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void
  /**
   * Right-click handler — saved layouts open a manage (rename/delete) menu.
   * Attached to the item shell (not the inner button) so it still fires on
   * disabled items.
   */
  onContextMenu?: (
    item: ModuleInserterItem,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void
}

function stopFavoritePointer(event: ReactPointerEvent<HTMLButtonElement>) {
  event.stopPropagation()
}

export function ModuleInserterItemButton({
  item,
  view,
  selected,
  onSelect,
  onPick,
  favorite,
  onToggleFavorite,
  onPointerDown,
  onContextMenu,
}: InserterItemButtonProps) {
  const isList = view === 'list'
  const disabled = Boolean(item.disabledReason)
  const favoriteLabel = favorite
    ? `Remove ${item.name} from notch favorites`
    : `Add ${item.name} to notch favorites`

  function handleFavoriteClick(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    onToggleFavorite()
  }

  return (
    <div
      className={cn(styles.itemShell, disabled && styles.itemShellDisabled)}
      data-accent={item.accent}
      onContextMenu={onContextMenu ? (event) => onContextMenu(item, event) : undefined}
    >
      <Button
        variant="ghost"
        size="sm"
        align="start"
        className={isList ? styles.rowItem : styles.tileItem}
        onPointerMove={onSelect}
        onFocus={onSelect}
        onClick={onPick}
        onPointerDown={(event) => onPointerDown(item, event)}
        disabled={disabled}
        tooltip={item.disabledReason}
        data-selected={selected ? 'true' : undefined}
        data-accent={item.accent}
        data-module-id={item.kind === 'module' ? item.id : undefined}
        data-layout-id={item.kind === 'layout' ? item.id : undefined}
        data-saved-layout-id={item.kind === 'savedLayout' ? item.id : undefined}
        data-vc-id={item.kind === 'component' ? item.id : undefined}
      >
        {isList ? <ItemRow item={item} /> : <ItemTile item={item} />}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        className={styles.favoriteButton}
        onClick={handleFavoriteClick}
        onPointerDown={stopFavoritePointer}
        aria-label={favoriteLabel}
        aria-pressed={favorite}
        tooltip={favoriteLabel}
      >
        <StarSolidIcon size={13} aria-hidden="true" />
      </Button>
    </div>
  )
}

function ItemTile({ item }: { item: ModuleInserterItem }) {
  return (
    <>
      <span className={styles.dragGrip} aria-hidden="true">
        <HandGrabSolidIcon size={13} />
      </span>
      <span className={styles.tileAdd} aria-hidden="true">
        <PlusIcon size={13} />
      </span>
      <span className={styles.tileStage}>
        <ModuleWireframe node={item.wire} />
      </span>
      <span className={styles.tileMeta}>
        <span className={styles.itemTitle}>
          <ItemIcon item={item} />
          <span>{item.name}</span>
        </span>
        <span className={styles.itemDescription}>{itemDescription(item)}</span>
      </span>
    </>
  )
}

function ItemRow({ item }: { item: ModuleInserterItem }) {
  return (
    <>
      <span className={styles.rowGrip} aria-hidden="true">
        <HandGrabSolidIcon size={13} />
      </span>
      <span className={styles.rowThumb}>
        <ModuleWireframe node={item.wire} />
      </span>
      <span className={styles.rowMain}>
        <span className={styles.itemTitle}>
          <ItemIcon item={item} />
          <span>{item.name}</span>
        </span>
        <span className={styles.itemDescription}>{itemDescription(item)}</span>
      </span>
    </>
  )
}

function ItemIcon({ item }: { item: ModuleInserterItem }) {
  if (item.kind === 'module') {
    return <ModuleIcon module={item.module} size={13} aria-hidden="true" />
  }
  if (item.kind === 'layout' || item.kind === 'savedLayout') {
    return <LayoutSolidIcon size={13} aria-hidden="true" />
  }
  if (item.kind === 'component') {
    return <BracesIcon size={13} aria-hidden="true" />
  }
  const _exhaustive: never = item
  return _exhaustive
}
