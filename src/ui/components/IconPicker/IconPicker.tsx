/**
 * `IconPicker` — choose an icon from the generated icon packs.
 *
 * Rendered inside a {@link FloatingPanel} anchored beside its trigger (the
 * inspector's "Icons" button), so picking an icon feels like every other
 * floating editor — draggable header, closed by ×, Escape, or clicking
 * outside.
 *
 * Returns inline SVG MARKUP, not a component, because that is what the caller
 * stores: `base.svg` keeps a markup string and publishes it through the
 * DOMPurify boundary, which is already the right home for an icon on a page.
 * Picking an icon is therefore just filling in that prop — no new module, no
 * second publish path.
 *
 * Only the pack registry is imported eagerly; each pack's icon data arrives
 * through its `load()` dynamic import the first time that family is opened.
 * Nothing here imports an icon component, so browsing the whole catalogue
 * costs no bundle weight and needs no lazy `Icon` wrapper — the two failure
 * modes `direct-icon-imports.test.ts` exists to prevent.
 */
import { useEffect, useState, type RefObject } from 'react'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { EmptyState } from '@ui/components/EmptyState'
import { ICON_PACKS } from '@ui/icons/packs/registry'
import styles from './IconPicker.module.css'

type IconEntry = readonly [name: string, svg: string]

interface IconPickerProps {
  open: boolean
  onClose: () => void
  /** The trigger button the panel opens beside. */
  anchorRef: RefObject<HTMLElement | null>
  /** Receives ready-to-store inline SVG markup for the chosen icon. */
  onPick: (svgMarkup: string, name: string) => void
}

const PANEL_WIDTH = 380
const PANEL_ESTIMATED_HEIGHT = 480

// ponytail: render cap instead of a windowed list — 6k tiles in one paint
// stalls; a virtualized grid is the upgrade path if browsing (not searching)
// the big families ever matters.
const RENDER_CAP = 400

/** Turn `arrow-right-solid` into `arrow right solid` so a space-separated
 *  query matches the way a person types it. */
function searchable(name: string): string {
  return name.replace(/-/g, ' ')
}

export function IconPicker({ open, onClose, anchorRef, onPick }: IconPickerProps) {
  const [query, setQuery] = useState('')
  const [packId, setPackId] = useState(ICON_PACKS[0].id)
  // Loaded pack tagged with its id, so switching packs derives "loading"
  // instead of an effect resetting state (react-hooks/set-state-in-effect).
  const [loaded, setLoaded] = useState<{ packId: string; icons: readonly IconEntry[] } | null>(null)
  const icons = loaded?.packId === packId ? loaded.icons : null

  useEffect(() => {
    if (!open || icons !== null) return
    const pack = ICON_PACKS.find((p) => p.id === packId) ?? ICON_PACKS[0]
    let cancelled = false
    pack
      .load()
      .then((packIcons) => {
        if (!cancelled) setLoaded({ packId: pack.id, icons: packIcons })
      })
      .catch((err) => {
        console.error('[IconPicker] failed to load icon pack:', err)
        if (!cancelled) setLoaded({ packId: pack.id, icons: [] })
      })
    return () => {
      cancelled = true
    }
  }, [open, packId, icons])

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  // Every term must appear, so "arrow solid" narrows instead of widening.
  const matches =
    icons === null
      ? []
      : terms.length === 0
        ? icons
        : icons.filter(([name]) => {
            const haystack = searchable(name)
            return terms.every((term) => haystack.includes(term))
          })
  const visible = matches.slice(0, RENDER_CAP)

  function choose([name, svg]: IconEntry) {
    onPick(svg, name)
    onClose()
  }

  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      title="Choose an icon"
      closeLabel="Close icon picker"
      width={PANEL_WIDTH}
      estimatedHeight={PANEL_ESTIMATED_HEIGHT}
    >
      <div className={styles.body}>
        <div className={styles.packs} role="tablist" aria-label="Icon families">
          {ICON_PACKS.map((pack) => (
            <Button
              key={pack.id}
              variant={pack.id === packId ? 'secondary' : 'ghost'}
              size="sm"
              role="tab"
              aria-selected={pack.id === packId}
              onClick={() => setPackId(pack.id)}
            >
              {pack.label}
            </Button>
          ))}
        </div>

        <SearchBar
          value={query}
          onValueChange={setQuery}
          placeholder="Search icons…"
          aria-label="Search icons"
        />

        <p className={styles.count} role="status">
          {icons === null
            ? 'Loading…'
            : matches.length > RENDER_CAP
              ? `Showing ${RENDER_CAP} of ${matches.length} matches — search to narrow`
              : `${matches.length} of ${icons.length} icons`}
        </p>

        <div className={styles.gridScroll}>
          {icons !== null && matches.length === 0 ? (
            <EmptyState
              title="No icons match that search"
              description="Icon names are kebab-case, e.g. “arrow right” or “trash solid”."
            />
          ) : (
            <div className={styles.grid}>
              {visible.map((entry) => (
                <Button
                  key={entry[0]}
                  variant="ghost"
                  shape="flush"
                  className={styles.tile}
                  onClick={() => choose(entry)}
                  aria-label={`Use the ${searchable(entry[0])} icon`}
                  tooltip={entry[0]}
                >
                  {/*
                    Generated, trusted-at-build-time markup; the stored value is
                    still sanitized at the publish boundary like any `base.svg`.
                    `aria-hidden` because the button already carries the name.
                  */}
                  <span
                    className={styles.glyph}
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: entry[1] }}
                  />
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </FloatingPanel>
  )
}
