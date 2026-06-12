import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { Input } from '@ui/components/Input'
import { CornerDownLeftIcon } from 'pixel-art-icons/icons/corner-down-left'
import { UndoIcon } from 'pixel-art-icons/icons/undo'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { cn } from '@ui/cn'
import { TagPill } from '@ui/components/TagPill'
import {
  classKindSelector,
  generatedClassKindLabel,
  styleRuleSelector,
  type StyleRule,
} from '@core/page-tree'
import type { SelectorPillItem, SelectorSuggestionItem } from './selectorPickerModel'
import styles from './ClassPicker.module.css'

const SELECTOR_SUGGESTIONS_MAX_WIDTH = 520

interface AssignedClassPillProps {
  cls: StyleRule
  isActive: boolean
  onToggle: () => void
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  onKeyboardContextMenu: (event: KeyboardEvent<HTMLElement>) => void
  onRemove: () => void
}

function AssignedClassPill({
  cls,
  isActive,
  onToggle,
  onContextMenu,
  onKeyboardContextMenu,
  onRemove,
}: AssignedClassPillProps) {
  const selectorLabel = styleRuleSelector(cls)
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
      return
    }
    onKeyboardContextMenu(e)
  }

  return (
    <TagPill
      label={selectorLabel}
      active={isActive}
      onClick={onToggle}
      onMainKeyDown={handleKeyDown}
      onContextMenu={onContextMenu}
      onRemove={onRemove}
      mainAriaLabel={`${isActive ? 'Deselect' : 'Edit'} class ${selectorLabel}`}
      removeAriaLabel={`Remove class ${selectorLabel}`}
      removeTooltip="Remove from this element"
      mainTestId={`class-chip-${cls.name}`}
      removeTestId={`class-chip-remove-${cls.name}`}
    />
  )
}

function AmbientSelectorPill({
  pill,
  onToggle,
}: {
  pill: SelectorPillItem
  onToggle: () => void
}) {
  const selectorLabel = styleRuleSelector(pill.rule)
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    }
  }

  return (
    <TagPill
      label={selectorLabel}
      active={pill.active}
      onClick={onToggle}
      onMainKeyDown={handleKeyDown}
      mainAriaLabel={`${pill.active ? 'Deselect' : 'Edit'} selector ${selectorLabel}`}
      mainTestId={`selector-chip-${pill.rule.id}`}
    />
  )
}

function InlineStylePill({
  isActive,
  onToggle,
  onRemove,
}: {
  isActive: boolean
  onToggle: () => void
  onRemove: () => void
}) {
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    }
  }

  return (
    <TagPill
      label="Inline"
      active={isActive}
      muted
      onClick={onToggle}
      onMainKeyDown={handleKeyDown}
      onRemove={onRemove}
      mainAriaLabel={`${isActive ? 'Stop editing' : 'Edit'} inline styles`}
      removeAriaLabel="Clear inline styles"
      removeTooltip="Clear inline styles"
      mainTestId="inline-style-pill"
      removeTestId="inline-style-pill-remove"
    />
  )
}

interface SelectorPillStackProps {
  pills: readonly SelectorPillItem[]
  showInlinePill: boolean
  inlineStyleEditing: boolean
  onToggleRule: (ruleId: string, active: boolean) => void
  onClassContextMenu: (classId: string, event: MouseEvent<HTMLElement>) => void
  onKeyboardClassContextMenu: (classId: string, event: KeyboardEvent<HTMLElement>) => void
  onRemoveClass: (classId: string) => void
  onToggleInline: () => void
  onClearInline: () => void
}

export function SelectorPillStack({
  pills,
  showInlinePill,
  inlineStyleEditing,
  onToggleRule,
  onClassContextMenu,
  onKeyboardClassContextMenu,
  onRemoveClass,
  onToggleInline,
  onClearInline,
}: SelectorPillStackProps) {
  if (pills.length === 0 && !showInlinePill) return null

  return (
    <div className={styles.pillsContainer}>
      {pills.map((pill) => (
        pill.rule.kind === 'ambient'
          ? (
              <AmbientSelectorPill
                key={pill.rule.id}
                pill={pill}
                onToggle={() => onToggleRule(pill.rule.id, pill.active)}
              />
            )
          : (
              <AssignedClassPill
                key={pill.rule.id}
                cls={pill.rule}
                isActive={pill.active}
                onToggle={() => onToggleRule(pill.rule.id, pill.active)}
                onContextMenu={(e) => onClassContextMenu(pill.rule.id, e)}
                onKeyboardContextMenu={(e) => onKeyboardClassContextMenu(pill.rule.id, e)}
                onRemove={() => onRemoveClass(pill.rule.id)}
              />
            )
      ))}
      {showInlinePill && (
        <InlineStylePill
          isActive={inlineStyleEditing}
          onToggle={onToggleInline}
          onRemove={onClearInline}
        />
      )}
    </div>
  )
}

interface SelectorInputAreaProps {
  inputRowRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  trailingAction?: ReactNode
  query: string
  hasSubmittableQuery: boolean
  submitTooltip: string
  onQueryChange: (query: string) => void
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onSubmit: () => void
  children: ReactNode
}

export function SelectorInputArea({
  inputRowRef,
  inputRef,
  trailingAction,
  query,
  hasSubmittableQuery,
  submitTooltip,
  onQueryChange,
  onFocus,
  onKeyDown,
  onSubmit,
  children,
}: SelectorInputAreaProps) {
  return (
    <div ref={inputRowRef} className={styles.inputRow} data-with-action={trailingAction != null}>
      <Input
        ref={inputRef}
        type="text"
        fieldSize="sm"
        value={query}
        onChange={(e) => {
          onQueryChange(e.target.value)
        }}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        placeholder="Add or create selector…"
        aria-label="Add or create a CSS selector"
        data-testid="class-picker-input"
        trailingSlot={
          <Button
            variant="ghost"
            size="micro"
            iconOnly
            disabled={!hasSubmittableQuery}
            tooltip={submitTooltip}
            aria-label="Submit selector"
            onMouseDown={(e) => {
              e.preventDefault()
            }}
            onClick={onSubmit}
            data-testid="class-picker-submit"
          >
            <CornerDownLeftIcon size={11} color="currentColor" aria-hidden="true" />
          </Button>
        }
      />

      {trailingAction}
      {children}
    </div>
  )
}

export function UnmatchedSelectorNotice({
  selector,
  onUndo,
}: {
  selector: string
  onUndo: () => void
}) {
  return (
    <div className={styles.noticeRow} aria-live="polite">
      <span>
        <span className={styles.noticeSelector}>{selector}</span>
        {' was added but does not match this element'}
      </span>
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        aria-label={`Undo selector ${selector} creation`}
        tooltip="Undo"
        onClick={onUndo}
      >
        <UndoIcon size={11} aria-hidden="true" />
      </Button>
    </div>
  )
}

interface RankedSuggestionsListProps {
  filteredSuggestions: readonly StyleRule[]
  selectorSuggestions: readonly SelectorSuggestionItem[]
  highlightedClassId: string | null
  highlightedSelectorId: string | null
  canCreateNew: boolean
  createValidationError: string | null
  createIntentKind: 'class' | 'ambient' | 'empty'
  query: string
  onPick: (classId: string) => void
  onPickSelector: (item: SelectorSuggestionItem) => void
  onCreateAndAdd: () => void
  previewClass: (classId: string) => void
  clearPreviewClass: (classId: string) => void
}

function RankedSuggestionsList({
  filteredSuggestions,
  selectorSuggestions,
  highlightedClassId,
  highlightedSelectorId,
  canCreateNew,
  createValidationError,
  createIntentKind,
  query,
  onPick,
  onPickSelector,
  onCreateAndAdd,
  previewClass,
  clearPreviewClass,
}: RankedSuggestionsListProps) {
  const hasClassSuggestions = filteredSuggestions.length > 0
  const hasSelectorSuggestions = selectorSuggestions.length > 0
  const createLabel = createIntentKind === 'ambient' ? 'selector' : 'class'
  const trimmedQuery = query.trim()
  const createText = createIntentKind === 'class'
    ? classKindSelector(trimmedQuery.startsWith('.') ? trimmedQuery.slice(1) : trimmedQuery)
    : trimmedQuery
  return (
    <>
      {filteredSuggestions.map((cls) => {
        const isHighlighted = highlightedClassId === cls.id
        return (
          <ContextMenuItem
            key={cls.id}
            data-class-suggestion-id={cls.id}
            data-selector-suggestion-id={cls.id}
            data-testid={`class-picker-suggestion-${cls.name}`}
            className={cn(isHighlighted && styles.suggestionHighlighted)}
            onClick={() => onPick(cls.id)}
            onMouseEnter={() => previewClass(cls.id)}
            onFocus={() => previewClass(cls.id)}
            onMouseLeave={() => clearPreviewClass(cls.id)}
            onBlur={() => clearPreviewClass(cls.id)}
          >
            <span className={styles.suggestionLabel}>{styleRuleSelector(cls)}</span>
            {generatedClassKindLabel(cls) && (
              <span className={styles.utilityBadge}>{generatedClassKindLabel(cls)}</span>
            )}
          </ContextMenuItem>
        )
      })}
      {hasSelectorSuggestions && (
        <>
          {hasClassSuggestions && <ContextMenuSeparator />}
          <div className={styles.sectionHeader}>Ambient selectors</div>
          <SelectorSuggestionRows
            items={selectorSuggestions}
            highlightedSelectorId={highlightedSelectorId}
            onPick={onPickSelector}
          />
        </>
      )}
      {canCreateNew && (
        <>
          {(hasClassSuggestions || hasSelectorSuggestions) && <ContextMenuSeparator />}
          <ContextMenuItem
            onClick={onCreateAndAdd}
            data-testid="class-picker-create-new"
          >
            + Create {createLabel} &ldquo;{createText}&rdquo;
          </ContextMenuItem>
        </>
      )}
      {createValidationError && (
        <>
          {(hasClassSuggestions || hasSelectorSuggestions) && <ContextMenuSeparator />}
          <InvalidSelectorSuggestionRow message={createValidationError} />
        </>
      )}
      {!hasClassSuggestions && !hasSelectorSuggestions && !canCreateNew && !createValidationError && (
        <div className={styles.noMatch}>
          No selectors match &ldquo;{query}&rdquo;
        </div>
      )}
    </>
  )
}

interface SelectorSuggestionsVisibility {
  open: boolean
  hasRows: boolean
  canCreate: boolean
  emptyQuery: boolean
}

interface SelectorSuggestionsSections {
  showAllHeader: boolean
  surfacedCount: number
}

interface SelectorSuggestionsPortalProps {
  visibility: SelectorSuggestionsVisibility
  sections: SelectorSuggestionsSections
  inputRowRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  recentIds: readonly string[]
  frequentIds: readonly string[]
  remainingCandidates: readonly StyleRule[]
  selectorSuggestions: readonly SelectorSuggestionItem[]
  candidatesById: ReadonlyMap<string, StyleRule>
  filteredSuggestions: readonly StyleRule[]
  highlightedClassId: string | null
  highlightedSelectorId: string | null
  createIntentKind: 'class' | 'ambient' | 'empty'
  createValidationError: string | null
  query: string
  onClose: () => void
  onPick: (classId: string) => void
  onPickSelector: (item: SelectorSuggestionItem) => void
  onCreateAndAdd: () => void
  previewClass: (classId: string) => void
  clearPreviewClass: (classId: string) => void
}

export function SelectorSuggestionsPortal({
  visibility,
  sections,
  inputRowRef,
  inputRef,
  recentIds,
  frequentIds,
  remainingCandidates,
  selectorSuggestions,
  candidatesById,
  filteredSuggestions,
  highlightedClassId,
  highlightedSelectorId,
  createIntentKind,
  createValidationError,
  query,
  onClose,
  onPick,
  onPickSelector,
  onCreateAndAdd,
  previewClass,
  clearPreviewClass,
}: SelectorSuggestionsPortalProps) {
  if (!visibility.open || (!visibility.hasRows && !visibility.canCreate && visibility.emptyQuery)) {
    return null
  }

  return createPortal(
    <ContextMenu
      anchorRef={inputRowRef}
      side="auto"
      align="start"
      offset={6}
      matchAnchorWidth
      minWidth={240}
      maxWidth={SELECTOR_SUGGESTIONS_MAX_WIDTH}
      maxHeight={320}
      zIndex={10000}
      ariaLabel="Selector suggestions"
      onClose={onClose}
      triggerRef={inputRef}
    >
      {visibility.emptyQuery ? (
        <ClassSuggestionSections
          recentIds={recentIds}
          frequentIds={frequentIds}
          remainingClasses={sections.showAllHeader ? remainingCandidates : []}
          selectorSuggestions={selectorSuggestions}
          showAllHeader={sections.showAllHeader && sections.surfacedCount > 0}
          resolveClass={(id) => candidatesById.get(id) ?? null}
          onPick={onPick}
          onPickSelector={onPickSelector}
          previewClass={previewClass}
          clearPreviewClass={clearPreviewClass}
          highlightedClassId={highlightedClassId}
          highlightedSelectorId={highlightedSelectorId}
        />
      ) : (
        <RankedSuggestionsList
          filteredSuggestions={filteredSuggestions}
          selectorSuggestions={selectorSuggestions}
          highlightedClassId={highlightedClassId}
          highlightedSelectorId={highlightedSelectorId}
          canCreateNew={visibility.canCreate}
          createValidationError={createValidationError}
          createIntentKind={createIntentKind}
          query={query}
          onPick={onPick}
          onPickSelector={onPickSelector}
          onCreateAndAdd={onCreateAndAdd}
          previewClass={previewClass}
          clearPreviewClass={clearPreviewClass}
        />
      )}
    </ContextMenu>,
    document.body,
  )
}

function InvalidSelectorSuggestionRow({ message }: { message: string }) {
  return (
    <div
      className={styles.invalidSelectorRow}
      aria-live="polite"
      data-testid="class-picker-invalid-selector"
    >
      <span className={styles.invalidSelectorIcon} aria-hidden="true">
        <WarningDiamondSolidIcon size={12} />
      </span>
      <span className={styles.invalidSelectorMessage}>{message}</span>
    </div>
  )
}

interface ClassSuggestionSectionsProps {
  recentIds: readonly string[]
  frequentIds: readonly string[]
  remainingClasses: readonly StyleRule[]
  selectorSuggestions: readonly SelectorSuggestionItem[]
  showAllHeader: boolean
  resolveClass: (classId: string) => StyleRule | null
  onPick: (classId: string) => void
  onPickSelector: (item: SelectorSuggestionItem) => void
  previewClass: (classId: string) => void
  clearPreviewClass: (classId: string) => void
  highlightedClassId: string | null
  highlightedSelectorId: string | null
}

function ClassSuggestionSections({
  recentIds,
  frequentIds,
  remainingClasses,
  selectorSuggestions,
  showAllHeader,
  resolveClass,
  onPick,
  onPickSelector,
  previewClass,
  clearPreviewClass,
  highlightedClassId,
  highlightedSelectorId,
}: ClassSuggestionSectionsProps) {
  const hasRecent = recentIds.length > 0
  const hasFrequent = frequentIds.length > 0
  const hasRemaining = remainingClasses.length > 0
  const hasAmbient = selectorSuggestions.length > 0
  const hasAny = hasRecent || hasFrequent || hasRemaining || hasAmbient

  const renderItem = (cls: StyleRule) => {
    const isHighlighted = highlightedClassId === cls.id
    return (
      <ContextMenuItem
        key={cls.id}
        data-class-suggestion-id={cls.id}
        data-selector-suggestion-id={cls.id}
        data-testid={`class-picker-suggestion-${cls.name}`}
        className={cn(isHighlighted && styles.suggestionHighlighted)}
        onClick={() => onPick(cls.id)}
        onMouseEnter={() => previewClass(cls.id)}
        onFocus={() => previewClass(cls.id)}
        onMouseLeave={() => clearPreviewClass(cls.id)}
        onBlur={() => clearPreviewClass(cls.id)}
      >
        <span className={styles.suggestionLabel}>{styleRuleSelector(cls)}</span>
        {generatedClassKindLabel(cls) && (
          <span className={styles.utilityBadge}>{generatedClassKindLabel(cls)}</span>
        )}
      </ContextMenuItem>
    )
  }

  if (!hasAny) {
    return (
      <div className={styles.noMatch}>
        Type to search or create a selector
      </div>
    )
  }

  return (
    <>
      {hasRecent && (
        <>
          <div className={styles.sectionHeader}>Recent</div>
          {recentIds.map((id) => {
            const cls = resolveClass(id)
            return cls ? renderItem(cls) : null
          })}
        </>
      )}
      {hasFrequent && (
        <>
          {hasRecent && <ContextMenuSeparator />}
          <div className={styles.sectionHeader}>Frequent</div>
          {frequentIds.map((id) => {
            const cls = resolveClass(id)
            return cls ? renderItem(cls) : null
          })}
        </>
      )}
      {hasRemaining && (
        <>
          {(hasRecent || hasFrequent) && <ContextMenuSeparator />}
          {showAllHeader && <div className={styles.sectionHeader}>All classes</div>}
          {remainingClasses.map(renderItem)}
        </>
      )}
      {hasAmbient && (
        <>
          {(hasRecent || hasFrequent || hasRemaining) && <ContextMenuSeparator />}
          <div className={styles.sectionHeader}>Ambient selectors</div>
          <SelectorSuggestionRows
            items={selectorSuggestions}
            highlightedSelectorId={highlightedSelectorId}
            onPick={onPickSelector}
          />
        </>
      )}
    </>
  )
}

function SelectorSuggestionRows({
  items,
  highlightedSelectorId,
  onPick,
}: {
  items: readonly SelectorSuggestionItem[]
  highlightedSelectorId: string | null
  onPick: (item: SelectorSuggestionItem) => void
}) {
  return (
    <>
      {items.map((item) => {
        const label = styleRuleSelector(item.rule)
        const isHighlighted = highlightedSelectorId === item.rule.id
        return (
          <ContextMenuItem
            key={item.rule.id}
            data-selector-suggestion-id={item.rule.id}
            data-testid={`selector-picker-suggestion-${item.rule.id}`}
            className={cn(isHighlighted && styles.suggestionHighlighted)}
            disabled={item.disabled}
            tooltip={item.disabledReason ?? undefined}
            onClick={() => onPick(item)}
          >
            <span className={styles.suggestionLabel}>{label}</span>
            {item.disabledReason && (
              <span className={styles.suggestionMeta}>{item.disabledReason}</span>
            )}
          </ContextMenuItem>
        )
      })}
    </>
  )
}
