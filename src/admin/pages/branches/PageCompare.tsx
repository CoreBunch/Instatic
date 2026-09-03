/**
 * PageCompare — one page as main renders it and as the branch renders it,
 * in scaled, sandboxed frames. The HTML comes from the review's render
 * endpoint through the API client and is handed to the frame as `srcdoc`
 * (a frame navigation would not carry the admin session the same way);
 * once a frame has loaded, the nodes the plan lists as changed are found
 * by their `uid` attribute and outlined in place, so the highlights come
 * from the tree diff, not from guesses. Side by side, a swipe with one
 * frame clipped over the other, or the plain change list.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { MergeTreeDiff, ReviewRenderSide } from '@core/branches'
import { apiTextRequest, isAbortError } from '@core/http'
import { cmsBranchReviewRenderUrl } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Switch } from '@ui/components/Switch'
import styles from './BranchReviewPage.module.css'

const PAGE_WIDTH = 1280
const MIN_HEIGHT = 720
const MAX_HEIGHT = 2400

interface HighlightBox {
  id: string
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

  function measure(): void {
    const frame = frameRef.current
    const doc = frame?.contentDocument
    if (!frame || !doc?.documentElement) return
    const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, doc.documentElement.scrollHeight))
    setDocHeight(height)
    const next: HighlightBox[] = []
    for (const mark of marks) {
      const element = doc.querySelector(`[uid="${CSS.escape(mark.id)}"]`)
      if (!(element instanceof doc.defaultView!.HTMLElement)) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      next.push({
        id: mark.id,
        label: mark.label,
        tone: mark.tone,
        x: rect.left + (doc.defaultView?.scrollX ?? 0),
        y: rect.top + (doc.defaultView?.scrollY ?? 0),
        width: rect.width,
        height: rect.height,
      })
    }
    setBoxes(next)
    setLoaded(true)
  }

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
            key={box.id}
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
  const hasMain = action !== 'create'
  const hasBranch = action !== 'delete'
  const bothSides = hasMain && hasBranch

  const branchMarks = tree
    ? [
        ...tree.changed.map((id) => ({ id, label: tree.labels[id] ?? 'changed', tone: 'changed' as const })),
        ...tree.added.map((id) => ({ id, label: tree.labels[id] ?? 'added', tone: 'added' as const })),
      ]
    : []
  const mainMarks = tree ? tree.removed.map((id) => ({ id, label: tree.labels[id] ?? 'removed', tone: 'removed' as const })) : []
  const treeLines = tree
    ? [
        ...tree.added.map((id) => `Added ${tree.labels[id] ?? id}`),
        ...tree.changed.map((id) => `Changed ${tree.labels[id] ?? id}`),
        ...tree.removed.map((id) => `Removed ${tree.labels[id] ?? id}`),
      ]
    : []
  const lines = [...fieldLines, ...treeLines]

  return (
    <div>
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
          <div className={styles.swipeStack} style={{ '--split': `${split}%` } as CSSProperties}>
            <ScaledFrame branchId={branchId} rowId={rowId} side="branch" title={`${label} on the branch`} marks={branchMarks} showHighlights={showHighlights} />
            <div className={styles.swipeTop}>
              <ScaledFrame branchId={branchId} rowId={rowId} side="main" title={`${label} on main`} marks={mainMarks} showHighlights={showHighlights} />
            </div>
            <span className={styles.swipeLine} />
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
