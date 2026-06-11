/**
 * SpotlightRow — single result row in the command palette.
 *
 * Renders:
 *   - Leading icon (pixel-art-icons, 16px)
 *   - Label with <mark> highlighting for matched characters
 *   - Optional sublabel
 *   - Trailing <kbd> shortcut hint
 *   - Destructive confirm state: "Press ↵ again to confirm" inline text
 *
 * Accessibility: role="option", aria-selected
 */

import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import { SearchSolidIcon } from 'pixel-art-icons/icons/search-solid'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { UndoIcon } from 'pixel-art-icons/icons/undo'
import { RedoIcon } from 'pixel-art-icons/icons/redo'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { CursorMinimalSolidIcon } from 'pixel-art-icons/icons/cursor-minimal-solid'
import { PowerOffIcon } from 'pixel-art-icons/icons/power-off'
import { SettingsCogSolidIcon } from 'pixel-art-icons/icons/settings-cog-solid'
import { CommandIcon } from 'pixel-art-icons/icons/command'
import { BookOpenSolidIcon } from 'pixel-art-icons/icons/book-open-solid'
import { ArrowsHorizontalIcon } from 'pixel-art-icons/icons/arrows-horizontal'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { Copy2SolidIcon } from 'pixel-art-icons/icons/copy-2-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { ArrowUpIcon } from 'pixel-art-icons/icons/arrow-up'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { ContainerSolidIcon } from 'pixel-art-icons/icons/container-solid'
import { BoxSolidIcon } from 'pixel-art-icons/icons/box-solid'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
import { LaptopSolidIcon } from 'pixel-art-icons/icons/laptop-solid'
import { MonitorSolidIcon } from 'pixel-art-icons/icons/monitor-solid'
import { HandGrabSolidIcon } from 'pixel-art-icons/icons/hand-grab-solid'
import { PointerSolidIcon } from 'pixel-art-icons/icons/pointer-solid'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { FilePlusSolidIcon } from 'pixel-art-icons/icons/file-plus-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CopyXSolidIcon } from 'pixel-art-icons/icons/copy-x-solid'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'
import { ProportionsSolidIcon } from 'pixel-art-icons/icons/proportions-solid'
import { PowerIcon } from 'pixel-art-icons/icons/power'
import { DockSolidIcon } from 'pixel-art-icons/icons/dock-solid'
import { ShortcutKeys } from '@ui/components/Kbd'
import styles from './Spotlight.module.css'
import type { Command } from './types'
import { getKeybindingForCommand, isPlatformMac } from './keybindings'

// ─── Icon registry ────────────────────────────────────────────────────────────
// Maps iconName strings to pixel-art-icons components.

type IconComponent = React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: 'true' }>

const ICON_MAP: Record<string, IconComponent> = {
  // Phase 1 icons
  'search-solid': SearchSolidIcon,
  'save-solid': SaveSolidIcon,
  'send-solid': SendSolidIcon,
  'undo': UndoIcon,
  'redo': RedoIcon,
  'layout-solid': LayoutSolidIcon,
  'file-text-solid': FileTextSolidIcon,
  'database-solid': DatabaseSolidIcon,
  'image-solid': ImageSolidIcon,
  'images-solid': ImageSolidIcon,
  'package-solid': PackageSolidIcon,
  'cursor-minimal-solid': CursorMinimalSolidIcon,
  'power-off': PowerOffIcon,
  'settings-cog-solid': SettingsCogSolidIcon,
  'command': CommandIcon,
  'book-open-solid': BookOpenSolidIcon,
  'arrows-horizontal': ArrowsHorizontalIcon,
  'sliders-horizontal': SlidersHorizontalIcon,
  // Phase 2 icons
  'copy-solid': CopySolidIcon,
  'copy-2-solid': Copy2SolidIcon,
  'copy-x-solid': CopyXSolidIcon,
  'trash-solid': TrashSolidIcon,
  'lock-solid': LockSolidIcon,
  'eye-solid': EyeSolidIcon,
  'arrow-up': ArrowUpIcon,
  'arrow-down': ArrowDownIcon,
  'plus': PlusIcon,
  'edit-solid': EditSolidIcon,
  'container-solid': ContainerSolidIcon,
  'box-solid': BoxSolidIcon,
  'box-stack-solid': BoxStackSolidIcon,
  'ai-box-solid': AiBoxSolidIcon,
  'sparkles-solid': SparklesSolidIcon,
  'laptop-solid': LaptopSolidIcon,
  'monitor-solid': MonitorSolidIcon,
  'hand-grab-solid': HandGrabSolidIcon,
  'pointer-solid': PointerSolidIcon,
  'colors-swatch-solid': ColorsSwatchSolidIcon,
  'file-plus-solid': FilePlusSolidIcon,
  'code': CodeIcon,
  'external-link-solid': ExternalLinkSolidIcon,
  'circle-alert-solid': CircleAlertSolidIcon,
  'check': CheckIcon,
  'braces': BracesIcon,
  'list-box-solid': ListBoxSolidIcon,
  'proportions-solid': ProportionsSolidIcon,
  'power': PowerIcon,
  'dock-solid': DockSolidIcon,
}

function SpotlightRowIcon({ iconName }: { iconName?: string }): ReactNode {
  if (!iconName) return null
  const IconCmp = ICON_MAP[iconName] ?? SearchSolidIcon
  return <IconCmp size={16} aria-hidden="true" />
}

// ─── Match highlight ──────────────────────────────────────────────────────────

function HighlightedLabel({
  label,
  ranges,
}: {
  label: string
  ranges: Array<[number, number]>
}): ReactNode {
  if (ranges.length === 0) return <>{label}</>

  const parts: ReactNode[] = []
  let cursor = 0

  for (const [start, end] of ranges) {
    if (cursor < start) {
      parts.push(label.slice(cursor, start))
    }
    parts.push(<mark key={start}>{label.slice(start, end)}</mark>)
    cursor = end
  }

  if (cursor < label.length) {
    parts.push(label.slice(cursor))
  }

  return <>{parts}</>
}

// isPlatformMac is from the keybindings registry (single platform-detection source)
const isMac = isPlatformMac()

// ─── SpotlightRow ─────────────────────────────────────────────────────────────

interface SpotlightRowProps {
  id: string
  command: Command
  isHighlighted: boolean
  /** Phase 2: row is in the destructive confirm state. */
  isConfirming?: boolean
  matchRanges: Array<[number, number]>
  onSelect: () => void
  onHighlight: () => void
}

export function SpotlightRow({
  id,
  command,
  isHighlighted,
  isConfirming,
  matchRanges,
  onSelect,
  onHighlight,
}: SpotlightRowProps): ReactNode {
  // Shortcut is looked up from the keybindings registry — single source of truth.
  const keybinding = getKeybindingForCommand(command.id)
  const shortcutLabel = keybinding
    ? (isMac ? keybinding.shortcut.mac : keybinding.shortcut.win)
    : undefined
  const ariaLabel = isConfirming
    ? `${command.title} — Press Enter again to confirm`
    : shortcutLabel
      ? `${command.title} · ${shortcutLabel}`
      : command.title

  return (
    <div
      id={id}
      role="option"
      aria-selected={isHighlighted}
      aria-label={ariaLabel}
      className={cn(
        styles.row,
        isHighlighted && styles.rowHighlighted,
        command.destructive && styles.rowDestructive,
        isConfirming && styles.rowConfirming,
      )}
      // Prevent the row from stealing focus from the search input on click —
      // critical for the arg-mode flow (clicking a command with args should
      // open the argument prompt with the input still focused so the user
      // can immediately start typing the argument value). Without this, the
      // <div> receives focus and the spotlight's input becomes dead until
      // re-clicked.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      onMouseEnter={onHighlight}
    >
      <span className={styles.rowIcon}>
        <SpotlightRowIcon iconName={command.iconName} />
      </span>
      <span className={styles.rowContent}>
        {isConfirming ? (
          <span className={styles.rowLabel}>
            <span className={styles.confirmText}>Press ↵ again to confirm</span>
          </span>
        ) : (
          <>
            <span className={styles.rowLabel}>
              <HighlightedLabel label={command.title} ranges={matchRanges} />
            </span>
            {command.subtitle && (
              <span className={styles.rowSublabel}>{command.subtitle}</span>
            )}
          </>
        )}
      </span>
      {!isConfirming && shortcutLabel && (
        <ShortcutKeys label={shortcutLabel} className={styles.rowShortcut} />
      )}
    </div>
  )
}
