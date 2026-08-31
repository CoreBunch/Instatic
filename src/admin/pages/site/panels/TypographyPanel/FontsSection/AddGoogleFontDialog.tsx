/**
 * AddGoogleFontDialog — modal that drives the install flow for one Google font.
 *
 * Two-step UX:
 *   1. Family picker: searchable list of bundled Google fonts with a live
 *      preview rendered in the family's own font (lazy-loaded via Google's
 *      keyless CSS endpoint — preview links live only inside the editor
 *      session and never end up in the published HTML).
 *   2. Variant + subset picker: multi-select grid of the variants and subsets
 *      the chosen family advertises. The user confirms; the server downloads
 *      the woff2 files and we receive a `FontEntry` to merge into site settings.
 *
 * The dialog composes the shared Dialog primitive for close and focus behavior.
 * Fetch/install state stays local here; the parent (`FontsSection`) only needs
 * to mount it when `open` is true and pass an `onInstalled(entry)` callback.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { FilterBar } from '@ui/components/FilterBar'
import { SearchBar } from '@ui/components/SearchBar'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import {
  estimateCmsGoogleFont,
  installCmsGoogleFont,
  listCmsGoogleFonts,
} from '@core/persistence/cmsFonts'
import type { FontEntry } from '@core/fonts'
import { compareVariants, parseVariant } from '@core/fonts'
import { loadFontPreview, loadFontPreviewWithVariants } from '@core/fonts'
import type { GoogleFontFamilyDto } from '@core/persistence/responseSchemas'
import styles from './FontsSection.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'
import { formatBytes } from '@admin/lib/formatBytes'

interface AddGoogleFontDialogProps {
  /** Families already installed (case-insensitive) — disabled in the picker. */
  installedFamilies: ReadonlySet<string>
  /**
   * When set, the dialog opens in edit mode: the family picker is skipped and
   * the variants/subsets step opens pre-selected with the entry's current
   * choices. Saving re-installs the family (the server re-downloads the woff2
   * slices and the caller replaces the existing entry).
   */
  editEntry?: FontEntry
  onCancel: () => void
  onInstalled: (entry: FontEntry) => void
}

// Initial batch sizes the previews on first render. The 2-column tile grid
// fits ~12-16 visible cards in a typical viewport, so 40 covers the first
// scroll fold + a buffer; further tiles light up as the user scrolls.
const PREVIEW_BATCH_SIZE = 40
const DEFAULT_PICKED_VARIANT = '400'
const DEFAULT_PICKED_SUBSET = 'latin'

/**
 * Debounce window for the size-estimate call. The user toggles variants in
 * rapid succession when they "select all" / clear; 300ms collapses those
 * bursts into a single CSS+HEAD round-trip on the server.
 */
const ESTIMATE_DEBOUNCE_MS = 300

interface EstimateState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  totalBytes?: number
  fileCount?: number
  error?: string
}

/**
 * Category filter chip options. The first chip is `All`; the rest mirror the
 * five Google Fonts categories present in our bundled snapshot
 * (Sans Serif × 710, Display × 463, Serif × 347, Handwriting × 252, Monospace × 50).
 */
const CATEGORY_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'Sans Serif', label: 'Sans' },
  { value: 'Serif', label: 'Serif' },
  { value: 'Display', label: 'Display' },
  { value: 'Handwriting', label: 'Handwriting' },
  { value: 'Monospace', label: 'Mono' },
]

async function runGoogleFontInstall(
  selected: GoogleFontFamilyDto,
  pickedVariants: string[],
  pickedSubsets: string[],
  setInstalling: (v: boolean) => void,
  setInstallError: (v: string | null) => void,
  onInstalled: (entry: FontEntry) => void,
): Promise<void> {
  setInstalling(true)
  setInstallError(null)
  try {
    const entry = await installCmsGoogleFont({
      family: selected.family,
      variants: pickedVariants,
      subsets: pickedSubsets,
    })
    onInstalled(entry)
  } catch (err) {
    setInstallError(getErrorMessage(err, 'Font install failed'))
  } finally {
    setInstalling(false)
  }
}

export function AddGoogleFontDialog({
  installedFamilies,
  editEntry,
  onCancel,
  onInstalled,
}: AddGoogleFontDialogProps) {
  const [families, setFamilies] = useState<GoogleFontFamilyDto[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selected, setSelected] = useState<GoogleFontFamilyDto | null>(null)
  const [pickedVariants, setPickedVariants] = useState<string[]>([])
  const [pickedSubsets, setPickedSubsets] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [previewBudget, setPreviewBudget] = useState(PREVIEW_BATCH_SIZE)
  // The network estimate covers only the case where there is something to size.
  // Empty / no-step states are derived synchronously below so we never need to
  // call setState inside the effect's render path.
  const [networkEstimate, setNetworkEstimate] = useState<EstimateState>({ status: 'idle' })

  // Fetch the Google Fonts directory once on mount. In edit mode, jump straight
  // to the variants/subsets step pre-selected with the entry's current choices
  // (done inside the async `.then` so we never setState synchronously in the
  // effect body — see `react-hooks/set-state-in-effect`).
  useEffect(() => {
    let cancelled = false
    listCmsGoogleFonts()
      .then((entries) => {
        if (cancelled) return
        setFamilies(entries)
        if (editEntry) {
          const dto = entries.find(
            (f) => f.family.toLowerCase() === editEntry.family.toLowerCase(),
          )
          if (dto) {
            setSelected(dto)
            loadFontPreviewWithVariants(dto.family, dto.variants)
            setPickedVariants([...editEntry.variants].sort(compareVariants))
            setPickedSubsets([...editEntry.subsets].sort())
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(getErrorMessage(err, 'Failed to load Google fonts list'))
      })
    return () => {
      cancelled = true
    }
  }, [editEntry])

  // Debounced size estimate for the variants step. Skips the network request
  // entirely when there's nothing to size — those zero-states are computed in
  // `displayedEstimate` below, so the effect never has to setState synchronously.
  useEffect(() => {
    if (!selected) return
    if (pickedVariants.length === 0 || pickedSubsets.length === 0) return

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setNetworkEstimate((prev) => (prev.status === 'loading' ? prev : { status: 'loading' }))
      estimateCmsGoogleFont(
        {
          family: selected.family,
          variants: pickedVariants,
          subsets: pickedSubsets,
        },
        undefined,
        undefined,
        { signal: controller.signal },
      )
        .then((result) => {
          if (controller.signal.aborted) return
          setNetworkEstimate({
            status: 'ready',
            totalBytes: result.totalBytes,
            fileCount: result.fileCount,
          })
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          if (err instanceof DOMException && err.name === 'AbortError') return
          setNetworkEstimate({
            status: 'error',
            error: getErrorMessage(err, 'Could not estimate size'),
          })
        })
    }, ESTIMATE_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [selected, pickedVariants, pickedSubsets])

  /**
   * The displayed estimate is the network value most of the time, but two
   * synchronous states sneak in front:
   *   - no family selected  → idle (the variants step isn't open).
   *   - empty selection      → ready/zero (don't show "Calculating…" forever).
   * This keeps the network state in sync with the real selection without
   * calling setState inside the network effect's synchronous body.
   */
  const displayedEstimate: EstimateState = (() => {
    if (!selected) return { status: 'idle' }
    if (pickedVariants.length === 0 || pickedSubsets.length === 0) {
      return { status: 'ready', totalBytes: 0, fileCount: 0 }
    }
    return networkEstimate
  })()

  const filtered = (() => {
    if (!families) return []
    const q = query.trim().toLowerCase()
    return families.filter((f) => {
      if (category !== 'all' && f.category !== category) return false
      if (q && !f.family.toLowerCase().includes(q)) return false
      return true
    })
  })()

  // Lazily load preview CSS for the first N visible families. Loading every
  // family at once would inject ~1500 link tags — IntersectionObserver is the
  // ideal control, but a fixed budget per scroll-batch is simpler and still
  // keeps the network footprint bounded.
  useEffect(() => {
    if (!filtered.length) return
    const slice = filtered.slice(0, previewBudget)
    for (const entry of slice) loadFontPreview(entry.family)
  }, [filtered, previewBudget])

  /**
   * Reset the preview budget back to the first batch when the user types a
   * new query — done from the change handler (not a sync setState in an
   * effect, which `react-hooks/set-state-in-effect` rightly forbids).
   */
  function handleQueryChange(next: string) {
    setQuery(next)
    setPreviewBudget(PREVIEW_BATCH_SIZE)
  }

  function handleCategoryChange(next: string) {
    setCategory(next)
    setPreviewBudget(PREVIEW_BATCH_SIZE)
  }

  function handlePick(entry: GoogleFontFamilyDto) {
    setSelected(entry)
    setInstallError(null)
    // Pre-load every advertised variant so the variants step renders each
    // weight in its own weight/style. Same transient-CDN guarantee as the
    // family-picker preview: never reaches published HTML.
    loadFontPreviewWithVariants(entry.family, entry.variants)
    // Pick sensible defaults: 400 if available, otherwise the lightest
    // variant. Latin if available, otherwise the first listed subset. Users
    // can change anything on the next step.
    const defaultVariant = entry.variants.includes(DEFAULT_PICKED_VARIANT)
      ? DEFAULT_PICKED_VARIANT
      : (entry.variants[0] ?? '')
    setPickedVariants(defaultVariant ? [defaultVariant] : [])
    const defaultSubset = entry.subsets.includes(DEFAULT_PICKED_SUBSET)
      ? DEFAULT_PICKED_SUBSET
      : (entry.subsets[0] ?? '')
    setPickedSubsets(defaultSubset ? [defaultSubset] : [])
  }

  async function handleInstall() {
    if (!selected || installing) return
    if (pickedVariants.length === 0 || pickedSubsets.length === 0) return
    await runGoogleFontInstall(selected, pickedVariants, pickedSubsets, setInstalling, setInstallError, onInstalled)
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!installing) onCancel()
      }}
      closeOnBackdrop={!installing}
      closeOnEscape={!installing}
      hideCloseButton={installing}
      title={
        editEntry
          ? `Edit font — ${editEntry.family}`
          : selected
            ? `Add font — ${selected.family}`
            : 'Add Google font'
      }
      size="xl"
      bodyClassName={styles.dialogBody}
      footer={selected ? (
        <>
          <EstimateHint estimate={displayedEstimate} />
          {/* No "Back" in edit mode: the family is fixed, so there's no picker
              step to return to — only Cancel / Save. */}
          {!editEntry && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setSelected(null)}
              disabled={installing}
            >
              Back
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => { void handleInstall() }}
            disabled={
              installing
              || pickedVariants.length === 0
              || pickedSubsets.length === 0
            }
          >
            {installing ? (
              <>
                <LoaderIcon size={12} aria-hidden="true" /> {editEntry ? 'Saving…' : 'Installing…'}
              </>
            ) : (
              editEntry ? 'Save changes' : 'Install font'
            )}
          </Button>
        </>
      ) : (
        <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
          Cancel
        </Button>
      )}
    >
      {selected ? (
        <VariantsAndSubsetsStep
          family={selected}
          pickedVariants={pickedVariants}
          pickedSubsets={pickedSubsets}
          onPickedVariantsChange={setPickedVariants}
          onPickedSubsetsChange={setPickedSubsets}
        />
      ) : (
        <FamilyPickerStep
          families={filtered}
          loading={families === null && !loadError}
          loadError={loadError}
          query={query}
          category={category}
          installedFamilies={installedFamilies}
          onQueryChange={handleQueryChange}
          onCategoryChange={handleCategoryChange}
          onPick={handlePick}
          onLoadMorePreviews={() => setPreviewBudget((n) => n + PREVIEW_BATCH_SIZE)}
        />
      )}

      {installError && (
        <p role="alert" className={styles.errorAlert}>{installError}</p>
      )}
    </Dialog>
  )
}

// ─── Family picker step ─────────────────────────────────────────────────────

interface FamilyPickerStepProps {
  families: GoogleFontFamilyDto[]
  loading: boolean
  loadError: string | null
  query: string
  category: string
  installedFamilies: ReadonlySet<string>
  onQueryChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onPick: (entry: GoogleFontFamilyDto) => void
  onLoadMorePreviews: () => void
}

function FamilyPickerStep({
  families,
  loading,
  loadError,
  query,
  category,
  installedFamilies,
  onQueryChange,
  onCategoryChange,
  onPick,
  onLoadMorePreviews,
}: FamilyPickerStepProps) {
  const listRef = useRef<HTMLDivElement>(null)
  function handleScroll() {
    const el = listRef.current
    if (!el) return
    // Trigger another preview batch when the user nears the bottom — same
    // mechanic IntersectionObserver would give us, with one fewer subscription.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      onLoadMorePreviews()
    }
  }

  return (
    <>
      <SearchBar
        value={query}
        onValueChange={onQueryChange}
        placeholder="Search Google Fonts…"
        aria-label="Search Google Fonts"
        className={styles.pickerSearch}
        autoFocus
      />

      <FilterBar<string>
        items={CATEGORY_FILTERS}
        value={category}
        onValueChange={onCategoryChange}
        groupLabel="Filter by category"
      />

      {loadError ? (
        <p role="alert" className={styles.errorAlert}>{loadError}</p>
      ) : loading ? (
        <SkeletonBlock minHeight={200} ariaLabel="Loading Google Fonts" />
      ) : families.length === 0 ? (
        <p className={styles.pickerEmpty}>No fonts match "{query}".</p>
      ) : (
        <div
          ref={listRef}
          className={styles.pickerList}
          role="listbox"
          aria-label="Google fonts"
          onScroll={handleScroll}
        >
          {families.map((entry) => {
            const installed = installedFamilies.has(entry.family.toLowerCase())
            return (
              <button
                key={entry.family}
                type="button"
                role="option"
                aria-selected={false}
                aria-label={`${entry.family}${installed ? ' (already installed)' : ''}`}
                disabled={installed}
                className={styles.pickerItem}
                onClick={() => { if (!installed) onPick(entry) }}
              >
                <span
                  className={styles.pickerName}
                  // Inline font-family is the entire point: each tile renders
                  // its name in its own font once the lazy-loaded preview
                  // CSS resolves. Falls back to system sans until then.
                  style={{ fontFamily: `"${entry.family}", system-ui, sans-serif` } as CSSProperties}
                >
                  {entry.family}
                </span>
                <span className={styles.pickerMeta}>
                  <span className={styles.pickerCategory}>{entry.category}</span>
                  {installed && (
                    <span className={styles.pickerInstalled}>Installed</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

// ─── Variants + subsets step ───────────────────────────────────────────────

interface VariantsAndSubsetsStepProps {
  family: GoogleFontFamilyDto
  pickedVariants: string[]
  pickedSubsets: string[]
  onPickedVariantsChange: (variants: string[]) => void
  onPickedSubsetsChange: (subsets: string[]) => void
}

const DEFAULT_PREVIEW_TEXT = 'The quick brown fox jumps over the lazy dog'

function VariantsAndSubsetsStep({
  family,
  pickedVariants,
  pickedSubsets,
  onPickedVariantsChange,
  onPickedSubsetsChange,
}: VariantsAndSubsetsStepProps) {
  const sortedVariants = [...family.variants].sort(compareVariants)
  const sortedSubsets = [...family.subsets].sort()
  const variantsSet = new Set(pickedVariants)
  const subsetsSet = new Set(pickedSubsets)

  // Pick the heaviest selected weight as the hero preview's font-weight so the
  // user immediately sees what their highest-weight choice looks like. Defaults
  // to 400 if nothing's selected.
  const heroWeight = (() => {
    const weights = pickedVariants
      .map((v) => parseVariant(v)?.weight)
      .filter((w): w is number => typeof w === 'number')
    return weights.length > 0 ? Math.max(...weights) : 400
  })()

  function toggleVariant(variant: string) {
    if (variantsSet.has(variant)) {
      onPickedVariantsChange(pickedVariants.filter((v) => v !== variant))
    } else {
      onPickedVariantsChange([...pickedVariants, variant].sort(compareVariants))
    }
  }

  function toggleSubset(subset: string) {
    if (subsetsSet.has(subset)) {
      onPickedSubsetsChange(pickedSubsets.filter((s) => s !== subset))
    } else {
      onPickedSubsetsChange([...pickedSubsets, subset].sort())
    }
  }

  const allVariantsPicked = pickedVariants.length === sortedVariants.length
  const allSubsetsPicked = pickedSubsets.length === sortedSubsets.length

  return (
    <>
      {/* Hero preview — large editable pangram in the actual font. Uses
          contenteditable rather than a textarea so the rendered text can
          breathe (no scrollbar / no input chrome). */}
      <div className={styles.preview}>
        <div className={styles.previewMeta}>
          <span className={styles.previewFamilyName}>{family.family}</span>
          <span className={styles.previewCategory}>{family.category}</span>
        </div>
        {/* contentEditable content is intentionally NOT rendered via React
            children. Re-rendering text children on every keystroke would reset
            the caret to position 0 (typing then appears reversed). Seeding via
            `dangerouslySetInnerHTML` with a stable string lets React's bail-out
            comparison leave the DOM alone on subsequent renders (e.g. when
            `heroWeight` changes), preserving the user's edits and caret. */}
        <p
          className={styles.previewSample}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          aria-label="Preview text"
          style={{
            fontFamily: `"${family.family}", system-ui, sans-serif`,
            fontWeight: heroWeight,
          } as CSSProperties}
          dangerouslySetInnerHTML={{ __html: DEFAULT_PREVIEW_TEXT }}
        />
      </div>

      {/* Variants — each row renders the variant's own weight + style as a
          live sample so the user sees the font, not just a label. */}
      <div className={styles.dialogSection}>
        <div className={styles.dialogSectionHeader}>
          <h3 className={styles.dialogSectionTitle}>
            Variants ({pickedVariants.length}/{sortedVariants.length})
          </h3>
          <button
            type="button"
            className={styles.dialogSectionSelectAll}
            onClick={() =>
              onPickedVariantsChange(allVariantsPicked ? [] : [...sortedVariants])
            }
          >
            {allVariantsPicked ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <ul className={styles.variantList} role="list">
          {sortedVariants.map((variant) => {
            const parsed = parseVariant(variant)
            const checked = variantsSet.has(variant)
            return (
              <li key={variant}>
                <label
                  className={styles.variantRow}
                  data-checked={checked ? 'true' : undefined}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleVariant(variant)}
                    aria-label={variantLabel(variant)}
                  />
                  <span
                    className={styles.variantSample}
                    style={{
                      fontFamily: `"${family.family}", system-ui, sans-serif`,
                      fontWeight: parsed?.weight ?? 400,
                      fontStyle: parsed?.italic ? 'italic' : 'normal',
                    } as CSSProperties}
                  >
                    {variantLabel(variant)}
                  </span>
                  <span className={styles.variantWeightLabel}>
                    {parsed?.weight ?? variant}{parsed?.italic ? ' i' : ''}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Subsets — pill toggles. Aria-pressed encodes the on/off state so
          assistive tech reads it as a toggle button, not a checkbox. */}
      <div className={styles.dialogSection}>
        <div className={styles.dialogSectionHeader}>
          <h3 className={styles.dialogSectionTitle}>
            Subsets ({pickedSubsets.length}/{sortedSubsets.length})
          </h3>
          <button
            type="button"
            className={styles.dialogSectionSelectAll}
            onClick={() =>
              onPickedSubsetsChange(allSubsetsPicked ? [] : [...sortedSubsets])
            }
          >
            {allSubsetsPicked ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <ul className={styles.subsetChips} role="list">
          {sortedSubsets.map((subset) => {
            const checked = subsetsSet.has(subset)
            return (
              <li key={subset}>
                <button
                  type="button"
                  className={styles.subsetChip}
                  aria-pressed={checked}
                  onClick={() => toggleSubset(subset)}
                >
                  {subset}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </>
  )
}

// ─── Estimate hint (dialog footer) ──────────────────────────────────────────

interface EstimateHintProps {
  estimate: EstimateState
}

/**
 * Render the live download-size estimate in the dialog footer. Anchored to the
 * left of the action row by `margin-inline-end: auto` in the CSS module so the
 * Back / Install buttons stay flush right.
 *
 * Visual states:
 *   - `idle`:    nothing (selection empty before debounce window opens).
 *   - `loading`: small loader + "Calculating size…".
 *   - `ready`:   "Selected: 42 KB" (or "no files" when nothing resolves).
 *   - `error`:   "Couldn't estimate size" with the actual error in the title.
 */
function EstimateHint({ estimate }: EstimateHintProps) {
  if (estimate.status === 'idle') {
    return <span className={styles.estimateHint} aria-hidden="true" />
  }
  if (estimate.status === 'loading') {
    return (
      <span className={styles.estimateHint} role="status" aria-live="polite">
        <LoaderIcon size={11} aria-hidden="true" />
        <span>Calculating size…</span>
      </span>
    )
  }
  if (estimate.status === 'error') {
    return (
      <span
        className={styles.estimateHintError}
        role="status"
        aria-live="polite"
        title={estimate.error}
      >
        Couldn’t estimate size
      </span>
    )
  }
  if (!estimate.totalBytes || !estimate.fileCount) {
    return (
      <span className={styles.estimateHint} role="status" aria-live="polite">
        No files selected
      </span>
    )
  }
  return (
    <span className={styles.estimateHint} role="status" aria-live="polite">
      <strong className={styles.estimateValue}>{formatBytes(estimate.totalBytes, { maxUnit: 'MB' })}</strong>
      <span className={styles.estimateMeta}>
        {estimate.fileCount} {estimate.fileCount === 1 ? 'file' : 'files'}
      </span>
    </span>
  )
}

/**
 * Format a variant tag for the checkbox label.
 *   "400"        → "Regular 400"
 *   "700italic"  → "Bold 700 Italic"
 *   "300italic"  → "Light 300 Italic"
 */
function variantLabel(variant: string): string {
  const parsed = parseVariant(variant)
  if (!parsed) return variant
  const weightName = WEIGHT_NAMES[parsed.weight] ?? `Weight ${parsed.weight}`
  return parsed.italic ? `${weightName} Italic` : weightName
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
}
