/**
 * PageCompare — one page as main renders it and as the branch renders it,
 * in scaled, sandboxed frames. The HTML comes from the review's render
 * endpoint through the API client and is handed to the frame as `srcdoc`
 * (a frame navigation would not carry the admin session the same way);
 * once a frame has loaded, the nodes the plan lists as changed are found
 * by their `uid` attribute and outlined in place, so the highlights come
 * from the tree diff, not from guesses. Side by side, a swipe with one
 * frame clipped over the other, or the plain change list.
 *
 * Rendered ids are the COMPOSED ids (a page spliced into its template
 * chain gets a prefix), so every `uid` is resolved back to its page node
 * through `composedNodeSourceId` before it is matched against the plan.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { REVIEW_VIEWPORT, type MergeTreeDiff, type ReviewRenderSide } from '@core/branches'
import { apiTextRequest, isAbortError } from '@core/http'
import { cmsBranchReviewRenderUrl } from '@core/persistence'
import { composedNodeSourceId } from '@core/templates'
import { getErrorMessage } from '@core/utils/errorMessage'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Switch } from '@ui/components/Switch'
import { changedNodeLine } from './reviewFormat'
import styles from './BranchReviewPage.module.css'

// The frame is laid out at the review viewport's width; the server resolved
// the page's viewport units against the same viewport, so a `vh` hero is as
// tall as on a screen although the frame is as tall as the document.
const PAGE_WIDTH = REVIEW_VIEWPORT.width
const MIN_HEIGHT = 360
const MAX_HEIGHT = 2400

interface HighlightBox {
  key: string
  label: string
  tone: 'added' | 'changed' | 'removed'
  x: number
  y: number
  width: number
  height: number
}

interface FrameProps {
  branchId: string
  rowId: string
  side: ReviewRenderSide
  title: string
  /** Node ids to outline in this frame, with their tone. */
  marks: Array<{ id: string; label: string; tone: HighlightBox['tone'] }>
  showHighlights: boolean
}

/**
 * Every rendered element that carries a node id, keyed by the PAGE node id
 * it came from. A node inside a loop renders once per item, so one id can
 * map to several elements; all of them are outlined.
 */
function elementsByNodeId(doc: Document): Map<string, HTMLElement[]> {
  const byId = new Map<string, HTMLElement[]>()
  const HTMLElementCtor = doc.defaultView?.HTMLElement
  if (!HTMLElementCtor) return byId
  for (const element of doc.querySelectorAll('[uid]')) {
    if (!(element instanceof HTMLElementCtor)) continue
    const uid = element.getAttribute('uid')
    if (!uid) continue
    const id = composedNodeSourceId(uid)
    byId.set(id, [...(byId.get(id) ?? []), element])
  }
  return byId
}

function ScaledFrame({ branchId, rowId, side, title, marks, showHighlights }: FrameProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [scale, setScale] = useState(0.3)
  const [docHeight, setDocHeight] = useState(MIN_HEIGHT)
  const [boxes, setBoxes] = useState<HighlightBox[]>([])
  const [loaded, setLoaded] = useState(false)
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    apiTextRequest(cmsBranchReviewRenderUrl(branchId, rowId, side), {
      signal: controller.signal,
      fallbackMessage: 'Could not render the page',
    })
      .then((text) => {
        if (!controller.signal.aborted) setHtml(text)
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return
        console.error('[branch-review] page render failed:', err)
        setError(getErrorMessage(err, 'Could not render the page'))
      })
    return () => controller.abort()
  }, [branchId, rowId, side])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width > 0) setScale(width / PAGE_WIDTH)
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // The marks come from the parent's plan; `measure` reads them through a
  // ref so it can stay a stable callback (it is an effect dependency below —
  // React Compiler exception 1).
  const marksRef = useRef(marks)
  useEffect(() => {
    marksRef.current = marks
  })
  const measure = useCallback((): void => {
    const frame = frameRef.current
    const doc = frame?.contentDocument
    if (!frame || !doc?.documentElement) return
    const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, doc.documentElement.scrollHeight))
    setDocHeight(height)
    const byId = elementsByNodeId(doc)
    const scrollX = doc.defaultView?.scrollX ?? 0
    const scrollY = doc.defaultView?.scrollY ?? 0
    const next: HighlightBox[] = []
    for (const mark of marksRef.current) {
      for (const [index, element] of (byId.get(mark.id) ?? []).entries()) {
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        next.push({
          key: `${mark.id}:${index}`,
          label: mark.label,
          tone: mark.tone,
          x: rect.left + scrollX,
          y: rect.top + scrollY,
          width: rect.width,
          height: rect.height,
        })
      }
    }
    setBoxes(next)
    setLoaded(true)
  }, [])

  // Marks come from the plan; a reload can change them while the HTML is
  // the same, so the boxes follow the marks, not only the frame's load.
  const marksKey = marks.map((mark) => `${mark.tone}:${mark.id}`).join('|')
  useEffect(() => {
    if (loaded) measure()
  }, [marksKey, loaded, measure])

  const hostStyle = { '--frame-scale': scale, '--frame-h': `${docHeight * scale}px` } as CSSProperties
  const stageStyle = { '--doc-h': `${docHeight}px` } as CSSProperties
  if (error) {
    return (
      <div ref={hostRef} className={styles.frameHost} style={hostStyle} data-loaded="error" role="alert">
        <p className={styles.frameError}>{error}</p>
      </div>
    )
  }
  return (
    <div ref={hostRef} className={styles.frameHost} style={hostStyle} data-loaded={loaded ? 'true' : 'false'}>
      <div className={styles.frameStage} style={stageStyle}>
        {html !== null && (
          <iframe
            ref={frameRef}
            title={title}
            srcDoc={html}
            sandbox="allow-same-origin"
            referrerPolicy="no-referrer"
            className={styles.frame}
            tabIndex={-1}
            onLoad={measure}
          />
        )}
        {showHighlights && boxes.map((box) => (
          <span
            key={box.key}
            className={styles.highlight}
            data-tone={box.tone}
            style={{ '--hl-x': `${box.x}px`, '--hl-y': `${box.y}px`, '--hl-w': `${box.width}px`, '--hl-h': `${box.height}px` } as CSSProperties}
          >
            <span className={styles.highlightLabel}>{box.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

type Mode = 'side' | 'swipe' | 'list'

/**
 * "Changed · Hero title" when the node carries a name of its own; a bare
 * "Changed" when the plan could only name its module (`text`, `container`).
 */
function markLabel(verb: string, nodeLabel: string | undefined): string {
  if (!nodeLabel || /^[a-z][a-z0-9-]*$/.test(nodeLabel)) return verb
  return `${verb} · ${nodeLabel}`
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function releaseSwipePointer(event: PointerEvent<HTMLDivElement>): void {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
}

interface PageCompareProps {
  branchId: string
  rowId: string
  label: string
  action: 'create' | 'update' | 'delete'
  tree: MergeTreeDiff | null
  /** Plain-text field changes shown in the "What changed" list. */
  fieldLines: string[]
  mainLabel: string
}

export function PageCompare({ branchId, rowId, label, action, tree, fieldLines, mainLabel }: PageCompareProps) {
  const [mode, setMode] = useState<Mode>('side')
  const [showHighlights, setShowHighlights] = useState(true)
  const [split, setSplit] = useState(50)
  const stackRef = useRef<HTMLDivElement | null>(null)
  const hasMain = action !== 'create'
  const hasBranch = action !== 'delete'
  const bothSides = hasMain && hasBranch

  const branchMarks = tree
    ? [
        ...tree.changed.map((id) => ({ id, label: markLabel('Changed', tree.labels[id]), tone: 'changed' as const })),
        ...tree.added.map((id) => ({ id, label: markLabel('Added', tree.labels[id]), tone: 'added' as const })),
      ]
    : []
  const mainMarks = tree ? tree.removed.map((id) => ({ id, label: markLabel('Removed', tree.labels[id]), tone: 'removed' as const })) : []
  const treeLines = tree
    ? [
        ...tree.added.map((id) => `Added ${tree.labels[id] ?? id}`),
        ...tree.changed.map((id) => changedNodeLine(tree, id)),
        ...tree.removed.map((id) => `Removed ${tree.labels[id] ?? id}`),
      ]
    : []
  const lines = [...fieldLines, ...treeLines]

  // Drag anywhere on the stack to move the divider; the frames ignore the
  // pointer, so the stack sees every event. The range below keeps the
  // keyboard path.
  function splitFromPointer(event: PointerEvent<HTMLDivElement>): number {
    const rect = stackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return split
    return clampPercent(((event.clientX - rect.left) / rect.width) * 100)
  }
  function onStackPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setSplit(splitFromPointer(event))
  }
  function onStackPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    setSplit(splitFromPointer(event))
  }

  return (
    <div className={styles.compare}>
      <div className={styles.compareBar}>
        <SegmentedControl
          value={mode}
          size="xs"
          aria-label="Compare mode"
          options={[
            { value: 'side', label: 'Side by side' },
            { value: 'swipe', label: 'Swipe', tooltip: bothSides ? undefined : 'Needs both sides' },
            { value: 'list', label: 'What changed' },
          ]}
          onChange={(next) => {
            if (next === 'swipe' && !bothSides) return
            setMode(next)
          }}
        />
        <span className={styles.spacer} />
        {(branchMarks.length > 0 || mainMarks.length > 0) && mode !== 'list' && (
          <label className={styles.compareToggle}>
            <Switch checked={showHighlights} onCheckedChange={setShowHighlights} switchSize="sm" aria-label="Highlight changes" />
            <span>Highlight changes</span>
          </label>
        )}
      </div>

      {mode === 'list' ? (
        lines.length > 0 ? (
          <ul className={styles.changeList}>
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.changeListEmpty}>Only the tree's order or metadata changed.</p>
        )
      ) : mode === 'swipe' && bothSides ? (
        <div className={styles.swipe}>
          <div
            ref={stackRef}
            className={styles.swipeStack}
            style={{ '--split': `${split}%` } as CSSProperties}
            onPointerDown={onStackPointerDown}
            onPointerMove={onStackPointerMove}
            onPointerUp={releaseSwipePointer}
            onPointerCancel={releaseSwipePointer}
            data-testid="review-swipe-stack"
          >
            <ScaledFrame branchId={branchId} rowId={rowId} side="branch" title={`${label} on the branch`} marks={branchMarks} showHighlights={showHighlights} />
            <div className={styles.swipeTop}>
              <ScaledFrame branchId={branchId} rowId={rowId} side="main" title={`${label} on main`} marks={mainMarks} showHighlights={showHighlights} />
            </div>
            <span className={styles.swipeLine} />
            <span className={styles.swipeHandle} aria-hidden="true">
              <span className={styles.swipeHandleGrip} />
            </span>
            <span className={styles.swipeTagLeft}>{mainLabel}</span>
            <span className={styles.swipeTagRight}>Branch</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={split}
            aria-label="Reveal the branch version"
            className={styles.swipeRange}
            onChange={(event) => setSplit(Number(event.target.value))}
          />
        </div>
      ) : (
        <div className={styles.compareGrid} data-single={bothSides ? 'false' : 'true'}>
          {hasMain && (
            <div className={styles.compareCol}>
              <div className={styles.compareLabel}>{mainLabel}</div>
              <ScaledFrame branchId={branchId} rowId={rowId} side="main" title={`${label} on main`} marks={mainMarks} showHighlights={showHighlights} />
            </div>
          )}
          {hasBranch && (
            <div className={styles.compareCol}>
              <div className={styles.compareLabel}>{action === 'create' ? 'Branch, new page' : 'Branch'}</div>
              <ScaledFrame branchId={branchId} rowId={rowId} side="branch" title={`${label} on the branch`} marks={branchMarks} showHighlights={showHighlights} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
