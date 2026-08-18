/**
 * `UnsplashPicker` — browse Unsplash and pull a photo into the media library.
 *
 * One component, two jobs, separated only by whether `replaceAsset` is set:
 *   - no target  → the photo is imported as a NEW library asset,
 *   - a target   → the photo replaces that asset's bytes, keeping its id and
 *                  public path so every page already using it swaps over.
 *
 * The grid opens on Unsplash's editorial feed rather than an empty state with
 * a prompt: the common case is "I need a photo of roughly this mood", and
 * something to look at answers that faster than a blinking cursor. Typing
 * switches the same grid to search results.
 *
 * Paging is infinite-scroll driven by an `IntersectionObserver` on a sentinel
 * after the last tile — not a "load more" button, because the feed has no
 * meaningful end and a button would just be a manual scroll trigger.
 *
 * Attribution is rendered on every tile, and the server additionally stores it
 * on the imported asset. Both are required by the Unsplash licence; the
 * on-tile credit is what makes it visible while choosing, the stored caption is
 * what makes it survive.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { EmptyState } from '@ui/components/EmptyState'
import { Skeleton } from '@ui/components/Skeleton'
import { pushToast } from '@ui/components/Toast'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  importCmsUnsplashPhoto,
  listCmsUnsplashPhotos,
  type CmsMediaAsset,
  type CmsUnsplashPhoto,
} from '@core/persistence/cmsMedia'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import styles from './UnsplashPicker.module.css'

interface UnsplashPickerProps {
  open: boolean
  onClose: () => void
  /**
   * When set, the chosen photo replaces THIS asset's binary instead of
   * creating a new one. The dialog's wording changes to match, because
   * "replace" is not undoable the way "add" is.
   */
  replaceAsset?: CmsMediaAsset | null
  /** Called with the created (or replaced) asset once the import lands. */
  onImported: (asset: CmsMediaAsset) => void
}

/** Debounce on the search box — one request per pause, not per keystroke. */
const SEARCH_DEBOUNCE_MS = 350

/** Tiles rendered as skeletons while the first page of a query loads. */
const SKELETON_COUNT = 12

export function UnsplashPicker({ open, onClose, replaceAsset, onImported }: UnsplashPickerProps) {
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [photos, setPhotos] = useState<CmsUnsplashPhoto[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [importingId, setImportingId] = useState<string | null>(null)
  const [loadedQuery, setLoadedQuery] = useState('')
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // Debounce the box into `activeQuery`, which is what actually triggers a
  // fetch. Two pieces of state rather than one so the input stays responsive
  // while the request it will cause is still pending.
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => setActiveQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query, open])

  // A new query is a new list, not more of the old one. Adjusted DURING
  // RENDER rather than in an effect: the reset is knowable the moment
  // `activeQuery` changes, and an effect would paint one frame of the previous
  // query's photos under the new query's heading.
  if (activeQuery !== loadedQuery) {
    setLoadedQuery(activeQuery)
    setPhotos([])
    setPage(1)
    setHasMore(false)
    setError('')
  }

  const loadPage = useCallback(
    async (targetPage: number, currentQuery: string, signal: AbortSignal) => {
      setLoading(true)
      try {
        const result = await listCmsUnsplashPhotos(currentQuery, targetPage, signal)
        if (signal.aborted) return
        // Append on later pages, replace on the first — the first page of a
        // NEW query must not land under the previous query's results.
        setPhotos((current) => (targetPage === 1 ? result.photos : [...current, ...result.photos]))
        setHasMore(result.hasMore)
        setError('')
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return
        console.error('[UnsplashPicker] load failed:', err)
        setError(getErrorMessage(err, 'Could not reach Unsplash'))
        setHasMore(false)
      } finally {
        if (!signal.aborted) setLoading(false)
      }
    },
    [],
  )

  // Fetching a page IS the "subscribe to an external system" case an effect is
  // for; `loadPage` flips the loading flag as part of that sync, which the rule
  // cannot distinguish from a cascading render. Same disable the upload queue
  // uses in MediaPage.tsx.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void loadPage(page, activeQuery, controller.signal)
    return () => controller.abort()
  }, [open, page, activeQuery, loadPage])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Infinite scroll. The observer is rebuilt whenever the conditions for
  // paging change, so it can never fire against a stale `page`.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!open || !sentinel || !hasMore || loading) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setPage((current) => current + 1)
      }
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [open, hasMore, loading])

  async function choose(photo: CmsUnsplashPhoto) {
    if (importingId) return
    setImportingId(photo.id)
    try {
      const asset = await importCmsUnsplashPhoto(photo.id, replaceAsset?.id ?? null)
      onImported(asset)
      onClose()
    } catch (err) {
      console.error('[UnsplashPicker] import failed:', err)
      pushToast({
        kind: 'error',
        title: replaceAsset ? 'Could not replace the image' : 'Could not import the photo',
        body: getErrorMessage(err, 'Unknown Unsplash import error'),
      })
    } finally {
      setImportingId(null)
    }
  }

  const showSkeletons = loading && photos.length === 0
  const showEmpty = !loading && !error && photos.length === 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Unsplash"
      title={replaceAsset ? `Replace ${replaceAsset.filename}` : 'Add a photo from Unsplash'}
      size="2xl"
    >
      <div className={styles.body}>
        <SearchBar
          value={query}
          onValueChange={setQuery}
          placeholder="Search Unsplash…"
          aria-label="Search Unsplash photos"
        />


        {error && <p className={styles.error} role="alert">{error}</p>}

        {showEmpty && (
          <EmptyState
            icon={<ImagesSolidIcon size={32} />}
            title={activeQuery ? 'No photos match that search' : 'No photos to show'}
            description={
              activeQuery
                ? 'Try a broader word — Unsplash searches photo tags, not filenames.'
                : 'Unsplash returned nothing for the editorial feed.'
            }
          />
        )}

        <div className={styles.grid}>
          {showSkeletons
            && Array.from({ length: SKELETON_COUNT }, (_, i) => (
              <Skeleton key={`skeleton-${i}`} width="100%" height={140} className={styles.skeletonTile} />
            ))}

          {photos.map((photo) => (
            <figure className={styles.tile} key={photo.id}>
              <Button
                variant="ghost"
                shape="flush"
                className={styles.tileButton}
                disabled={importingId !== null}
                onClick={() => void choose(photo)}
                aria-label={
                  photo.description
                    ? `Use "${photo.description}" by ${photo.photographerName}`
                    : `Use the photo by ${photo.photographerName}`
                }
              >
                <img
                  className={styles.thumb}
                  src={photo.thumbUrl}
                  alt={photo.description}
                  loading="lazy"
                  decoding="async"
                />
                {importingId === photo.id && (
                  <span className={styles.importing} role="status">Importing…</span>
                )}
              </Button>
              {/*
                Attribution is a licence obligation, so it is part of the tile
                rather than a hover affordance. The links open on Unsplash and
                already carry the UTM parameters the server attached.
              */}
              <figcaption className={styles.credit}>
                <a href={photo.photographerUrl} target="_blank" rel="noreferrer noopener">
                  {photo.photographerName}
                </a>
                {' · '}
                <a href={photo.unsplashUrl} target="_blank" rel="noreferrer noopener">
                  Unsplash
                </a>
              </figcaption>
            </figure>
          ))}
        </div>

        {/* Paging sentinel — kept out of the grid so it can't be mistaken for a tile. */}
        <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
        {loading && photos.length > 0 && (
          <p className={styles.loadingMore} role="status">Loading more…</p>
        )}
      </div>
    </Dialog>
  )
}
