/**
 * useDocumentSync — keeps an uncontrolled CodeMirror buffer in step with a
 * store-projected document without fighting the user's typing.
 *
 * The editor only reads its text on mount / key change, so a panel that
 * applies edits live needs to tell "the store changed because I just wrote"
 * (keep the buffer, caret and history) apart from "the store changed for
 * another reason" (selection, canvas undo, a co-editor — remount with the
 * new text). A store subscription compares each new projection against the
 * text the mounted buffer was opened with, or that the panel's own last
 * write produced, and bumps `revision` on a mismatch for the same document.
 * Wrap every own write in `runOwnWrite` so its store notifications are
 * ignored and the post-write projection becomes the new baseline.
 *
 * Projecting is expensive (a whole page's HTML or stylesheet), and the
 * store can change hundreds of times in one task — a collab document
 * loading node by node, an agent batch. Reads are therefore coalesced to
 * one per animation frame, against the latest state; re-projecting on
 * every notification allocated a full document per node and could exhaust
 * the renderer on a large site.
 */
import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import type { EditorStore } from '@site/store/types'

export interface ProjectedDocument {
  docKey: string
  text: string
}

export interface DocumentSyncSource<I> {
  /** The store fields the projection reads. */
  select: (state: EditorStore) => I
  /** Skip re-projecting when the selected inputs are unchanged. */
  equal: (a: I, b: I) => boolean
  /** Project the inputs (may consult the DOM). */
  read: (inputs: I) => ProjectedDocument | null
}

export interface DocumentSyncOptions {
  /**
   * While true, an external change to the same document updates the
   * baseline but does NOT remount the buffer — for panels holding an
   * unapplied draft, whose caret and text history must survive unrelated
   * store changes (the draft itself is kept by the panel).
   */
  holdRemounts?: boolean
}

export interface DocumentSync {
  /** Append to the editor's key: changes when an external edit needs a remount. */
  revision: number
  /** Run a store write of this panel's own; its notifications never remount. */
  runOwnWrite: <T>(write: () => T) => T
}

export function useDocumentSync<I>(
  source: DocumentSyncSource<I>,
  options: DocumentSyncOptions = {},
): DocumentSync {
  const [revision, setRevision] = useState(0)
  const syncedRef = useRef<ProjectedDocument | null>(null)
  const writingRef = useRef(false)
  const holdRef = useRef(options.holdRemounts === true)
  useEffect(() => {
    holdRef.current = options.holdRemounts === true
  }, [options.holdRemounts])

  useEffect(() => {
    const read = () => source.read(source.select(useEditorStore.getState()))
    syncedRef.current = read()
    let previous = source.select(useEditorStore.getState())
    let frame: number | null = null
    const compare = () => {
      frame = null
      const next = read()
      const synced = syncedRef.current
      syncedRef.current = next
      if (next && synced && next.docKey === synced.docKey && next.text !== synced.text && !holdRef.current) {
        setRevision((r) => r + 1)
      }
    }
    const unsubscribe = useEditorStore.subscribe((state) => {
      const current = source.select(state)
      if (source.equal(previous, current)) return
      previous = current
      if (writingRef.current) return
      // Coalesce: one projection per frame, whatever the burst.
      frame ??= requestAnimationFrame(compare)
    })
    return () => {
      unsubscribe()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [source])

  const runOwnWrite = <T,>(write: () => T): T => {
    writingRef.current = true
    try {
      return write()
    } finally {
      writingRef.current = false
      // Baseline = whatever the store projects NOW. On CodeMirrorEditor's
      // flush-on-switch (its cleanup flushes the pending edit of the OLD
      // document through the old onChange closure while the store already
      // shows the NEW document), this captures the new document — which is
      // exactly the buffer about to mount, so no spurious remount follows.
      // Remount decisions are docKey-gated, so the old document's write can
      // never be mistaken for an external change to the new one.
      syncedRef.current = source.read(source.select(useEditorStore.getState()))
    }
  }

  return { revision, runOwnWrite }
}
