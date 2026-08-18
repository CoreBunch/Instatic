/**
 * `IconPicker` — choose an icon from the vendored pixel-art set.
 *
 * Returns inline SVG MARKUP, not a component, because that is what the caller
 * stores: `base.svg` keeps a markup string and publishes it through the
 * DOMPurify boundary, which is already the right home for an icon on a page.
 * Picking an icon is therefore just filling in that prop — no new module, no
 * second publish path.
 *
 * The grid renders each icon straight from its path geometry in
 * `iconManifest.ts`. Nothing here imports an icon component, so browsing the
 * whole set costs no bundle weight and needs no lazy `Icon` wrapper — the two
 * failure modes `direct-icon-imports.test.ts` exists to prevent.
 *
 * ponytail: renders every match at once. Fine at the 136 icons vendored today;
 * once the full ~4,000-icon catalogue is vendored this needs a windowed list
 * (render only the visible rows), or the first paint of an empty query will
 * stall.
 */
import { useState } from 'react'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { EmptyState } from '@ui/components/EmptyState'
import { ICON_MANIFEST, iconSvgMarkup, type IconManifestEntry } from '@ui/icons/iconManifest'
import styles from './IconPicker.module.css'

interface IconPickerProps {
  open: boolean
  onClose: () => void
  /** Receives ready-to-store inline SVG markup for the chosen icon. */
  onPick: (svgMarkup: string, entry: IconManifestEntry) => void
}

/** Turn `arrow-right-solid` into `arrow right solid` so a space-separated
 *  query matches the way a person types it. */
function searchable(name: string): string {
  return name.replace(/-/g, ' ')
}

export function IconPicker({ open, onClose, onPick }: IconPickerProps) {
  const [query, setQuery] = useState('')

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  // Every term must appear, so "arrow solid" narrows instead of widening.
  const matches = terms.length === 0
    ? ICON_MANIFEST
    : ICON_MANIFEST.filter((entry) => {
        const haystack = searchable(entry.name)
        return terms.every((term) => haystack.includes(term))
      })

  function choose(entry: IconManifestEntry) {
    onPick(iconSvgMarkup(entry), entry)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Icons"
      title="Choose an icon"
      size="2xl"
    >
      <div className={styles.body}>
        <SearchBar
          value={query}
          onValueChange={setQuery}
          placeholder="Search icons…"
          aria-label="Search icons"
        />

        <p className={styles.count} role="status">
          {matches.length} of {ICON_MANIFEST.length} icons
        </p>

        {matches.length === 0 ? (
          <EmptyState
            title="No icons match that search"
            description="Icon names are kebab-case, e.g. “arrow right” or “trash solid”."
          />
        ) : (
          <div className={styles.grid}>
            {matches.map((entry) => (
              <Button
                key={entry.name}
                variant="ghost"
                shape="flush"
                className={styles.tile}
                onClick={() => choose(entry)}
                aria-label={`Use the ${searchable(entry.name)} icon`}
                tooltip={entry.name}
              >
                {/*
                  Rendered from geometry rather than an imported component, so
                  the grid stays free of 136 (eventually 4,000) module imports.
                  `aria-hidden` because the button already carries the name.
                */}
                <svg
                  className={styles.glyph}
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d={entry.d} />
                </svg>
              </Button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}
