/**
 * SettingsModal — global settings modal with left-rail navigation.
 *
 * Shares the visual language of the Spotlight palette and the Module
 * Inserter: a direct-token panel shell, an `--bg-surface-2` rail with
 * categorical accent icon chips, an accent-bar section header, and a
 * shared `Esc` keycap affordance (backdrop click / Esc both close — there
 * is no dedicated close button, matching the other two modals).
 *
 * Guideline #225 (Modal Shell Requirements, WCAG 2.1 AA):
 * - role="dialog" + aria-modal="true" + aria-labelledby
 * - Focus trapped inside modal while open (Tab / Shift+Tab cycle within)
 * - First interactive element receives focus on open
 * - Esc closes the modal and returns focus to the trigger element
 * - Backdrop click closes the modal
 *
 * data-testid="settings-modal" for Playwright (Guideline #221)
 */
import { useEffect, useRef } from 'react'
import { cn } from '@ui/cn'
import { useEditorStore } from '@site/store/store'
import { useAdminUi } from '@admin/state/adminUi'
import { Button } from '@ui/components/Button'
import { Kbd } from '@ui/components/Kbd'
import { SettingsCogSolidIcon } from 'pixel-art-icons/icons/settings-cog-solid'
import { CommandIcon } from 'pixel-art-icons/icons/command'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { GeneralSection } from './sections/GeneralSection'
import { PublishingSection } from './sections/PublishingSection'
import { ShortcutsSection } from './sections/ShortcutsSection'
import { PreferencesSection } from './sections/PreferencesSection'
import s from './SettingsModal.module.css'

// ─── Nav items ────────────────────────────────────────────────────────────────
// `accent` keys map to the categorical `--accent-*` tokens via the CSS
// module's `[data-accent]` rules — the same identity system the Module
// Inserter rail uses for its section icons.

const NAV_ITEMS = [
  { id: 'general',     label: 'General',     icon: SettingsCogSolidIcon,  accent: 'lilac' },
  { id: 'shortcuts',   label: 'Shortcuts',   icon: CommandIcon,           accent: 'sky'   },
  { id: 'publishing',  label: 'Publishing',  icon: UploadIcon,            accent: 'mint'  },
  { id: 'preferences', label: 'Preferences', icon: SlidersHorizontalIcon, accent: 'peach' },
] as const

type SectionId = typeof NAV_ITEMS[number]['id']

// ─── SettingsModal ────────────────────────────────────────────────────────────

export function SettingsModal() {
  // Visibility + active section both come from the tiny `adminUi` store.
  // Whichever surface opened the modal (editor SettingsButton via adminUi,
  // spotlight `editor.openSettings` via editor store) ends up writing
  // here — see `settingsSlice.ts`'s bridge for the editor → adminUi
  // mirror and `store.ts`'s `bindSettingsBridgeStoreApi` for the reverse.
  const open = useAdminUi((state) => state.settingsOpen)
  const adminUiSection = useAdminUi((state) => state.settingsSection)
  const closeAdminUi = useAdminUi((state) => state.closeSettings)

  // Section navigation also updates the editor store's `activeSection`
  // for downstream consumers (spotlight, future editor panels). The
  // modal is lazy-loaded — this editor-store import only fires when the
  // user actually opens settings, never on first paint.
  const setSectionStore = useEditorStore((state) => state.setSettingsSection)

  const activeSection = normalizeSection(adminUiSection)
  const activeItem = NAV_ITEMS.find((n) => n.id === activeSection) ?? NAV_ITEMS[0]
  const dialogRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  // Focus management: capture trigger on open, restore on close (Guideline #225)
  useEffect(() => {
    if (open) {
      if (document.activeElement instanceof HTMLElement) {
        triggerRef.current = document.activeElement
      }
      requestAnimationFrame(() => {
        navRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      })
    } else {
      triggerRef.current?.focus()
      triggerRef.current = null
    }
  }, [open])

  // Close routes through adminUi — the editor store's `isSettingsOpen`
  // gets cleared by the bridge in `settingsSlice.ts`.
  const handleClose = () => {
    closeAdminUi()
  }

  // Update section in BOTH stores. adminUi for the modal's own selection,
  // editor's settingsSlice for downstream readers (spotlight commands).
  const openAdminUi = useAdminUi((state) => state.openSettings)
  const handleSetSection = (id: SectionId) => {
    setSectionStore(id as Parameters<typeof setSectionStore>[0])
    openAdminUi(id)
  }

  // Focus trap + Esc handler
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleClose()
      return
    }

    if (e.key !== 'Tab') return

    const dialog = dialogRef.current
    if (!dialog) return

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null)

    if (focusable.length === 0) return

    const first = focusable[0]
    const last  = focusable[focusable.length - 1]

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={handleClose}
        className={s.backdrop}
      />

      {/* Dialog centering wrapper */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        aria-describedby="settings-modal-desc"
        data-testid="settings-modal"
        onKeyDown={handleKeyDown}
        className={s.dialogWrapper}
      >
        <div className={s.panel} data-accent={activeItem.accent}>
          {/* Screen-reader description */}
          <p id="settings-modal-desc" className={s.srOnly}>
            Site-level configuration. Press Escape to close.
          </p>

          {/* ── Left rail ─────────────────────────────────────────────────── */}
          <div className={s.rail}>
            <h2 id="settings-modal-title" className={s.brand}>
              <SettingsCogSolidIcon size={16} aria-hidden="true" />
              Settings
            </h2>

            <nav
              ref={navRef}
              aria-label="Settings sections"
              className={s.sectionList}
            >
              {NAV_ITEMS.map((item) => (
                <SettingsNavButton
                  key={item.id}
                  item={item}
                  active={activeSection === item.id}
                  onClick={() => handleSetSection(item.id)}
                />
              ))}
            </nav>

            <div className={s.railSpring} />

            <div className={s.shortcutFooter} aria-label="Settings keyboard shortcuts">
              <div className={s.shortcutHint}>
                <Kbd>Esc</Kbd>
                <span>close</span>
              </div>
            </div>
          </div>

          {/* ── Right content area ──────────────────────────────────────── */}
          <div className={s.main}>
            <header className={s.sectionHeader} data-accent={activeItem.accent}>
              <span className={s.sectionBar} aria-hidden="true" />
              <h3 className={s.sectionTitle}>{activeItem.label}</h3>
            </header>

            <div
              role="region"
              aria-label={activeItem.label}
              className={s.content}
            >
              {activeSection === 'general'     && <GeneralSection />}
              {activeSection === 'shortcuts'   && <ShortcutsSection />}
              {activeSection === 'publishing'  && <PublishingSection />}
              {activeSection === 'preferences' && <PreferencesSection />}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function normalizeSection(section: string | null | undefined): SectionId {
  return NAV_ITEMS.some((item) => item.id === section) ? (section as SectionId) : 'general'
}

function SettingsNavButton({
  item,
  active,
  onClick,
}: {
  item: (typeof NAV_ITEMS)[number]
  active: boolean
  onClick: () => void
}) {
  const NavIcon = item.icon
  return (
    <Button
      variant="ghost"
      size="md"
      align="start"
      onClick={onClick}
      data-accent={item.accent}
      aria-current={active ? 'page' : undefined}
      className={cn(s.navItem, active && s.navItemActive)}
    >
      <span className={s.navIcon} aria-hidden="true">
        <NavIcon size={16} />
      </span>
      <span className={s.navName}>{item.label}</span>
    </Button>
  )
}
