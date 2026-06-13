/**
 * Test helper: query for canvas-rendered DOM across breakpoint iframes.
 *
 * The canvas renders each breakpoint frame inside its own iframe (see
 * `docs/features/canvas-iframe-per-frame.md`). Tests that used to call
 * `document.querySelector('[data-node-id="..."]')` won't find anything because
 * the page tree lives in `iframe.contentDocument`. This helper hides that
 * detail by walking every canvas iframe in the test DOM and returning the
 * first match. Callers can therefore stay agnostic about whether the
 * canvas renders directly or via iframes.
 *
 * Readiness is asynchronous. A breakpoint frame mounts its iframe and then
 * portals the page tree into the iframe's `contentDocument` on a later commit,
 * so a queried node is not present on the synchronous render — it appears a
 * tick or two later. Tests MUST therefore wait on the actual condition (the
 * frame document / node being present) rather than sleeping a fixed duration:
 * a hardcoded sleep that happens to be enough on a fast laptop is exactly what
 * makes these tests flaky in CI. Use `waitForCanvasFrameDocument` /
 * `waitForCanvasNodeInFrame` below.
 */

import { waitFor } from '@testing-library/react'
import { expect } from 'bun:test'

/**
 * CI-tolerant ceiling for canvas-frame readiness. `waitFor` returns the instant
 * the condition holds, so this adds no time on a fast machine — it only widens
 * the headroom so a slow/contended CI runner doesn't trip the default 1000 ms
 * `waitFor` budget while the iframe mounts and the page tree portals in.
 */
export const CANVAS_FRAME_READY_TIMEOUT_MS = 5000

/**
 * Find the first element matching `selector` inside any canvas iframe (or
 * the parent document, as a fallback).
 */
export function queryCanvasElement<E extends Element = HTMLElement>(
  selector: string,
): E | null {
  // Try main document first — covers test surfaces that don't render the
  // canvas (e.g. snapshot tests of a single module preview).
  const directHit = document.querySelector<E>(selector)
  if (directHit) return directHit

  // Then each canvas iframe in turn.
  for (const iframe of allCanvasIframes()) {
    const doc = iframe.contentDocument
    if (!doc) continue
    const hit = doc.querySelector<E>(selector)
    if (hit) return hit
  }
  return null
}

/**
 * Find every element matching `selector` across all canvas iframes plus the
 * parent document. Returned in iframe-iteration order (matches the order of
 * `<iframe>` elements in the parent DOM).
 */
function queryCanvasElements<E extends Element = HTMLElement>(
  selector: string,
): E[] {
  const out: E[] = []
  out.push(...Array.from(document.querySelectorAll<E>(selector)))
  for (const iframe of allCanvasIframes()) {
    const doc = iframe.contentDocument
    if (!doc) continue
    out.push(...Array.from(doc.querySelectorAll<E>(selector)))
  }
  return out
}

/**
 * Look up a canvas iframe by its breakpoint id (matches the
 * `data-testid="canvas-frame-<id>"` wrapper that hosts the iframe).
 */
export function getCanvasFrameDocument(breakpointId: string): Document | null {
  for (const iframe of allCanvasIframes()) {
    if (iframe.contentDocument?.body?.getAttribute('data-breakpoint-id') === breakpointId) {
      return iframe.contentDocument
    }
  }
  return null
}

/**
 * Find a node in a specific breakpoint frame's iframe. Equivalent to the
 * legacy `document.querySelector('[data-breakpoint-id="X"] [data-node-id="Y"]')`
 * for callers that explicitly want one breakpoint's instance of a node.
 */
export function queryCanvasNodeInFrame<E extends Element = HTMLElement>(
  breakpointId: string,
  nodeId: string,
): E | null {
  const doc = getCanvasFrameDocument(breakpointId)
  if (!doc) return null
  return doc.querySelector<E>(`[data-node-id="${escapeAttr(nodeId)}"]`)
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '\\"')
}

function allCanvasIframes(): HTMLIFrameElement[] {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe')).filter(
    (i) => i.title.startsWith('Canvas frame for '),
  )
}

/**
 * Wait until a breakpoint frame's iframe document is mounted and ready, then
 * return it. Replaces fixed-duration "flush progressive frames" sleeps — polls
 * the real readiness condition so it is robust to the progressive reveal's
 * timing on any machine. Throws (via `waitFor`) if the frame never appears.
 */
export async function waitForCanvasFrameDocument(breakpointId: string): Promise<Document> {
  let doc: Document | null = null
  await waitFor(
    () => {
      doc = getCanvasFrameDocument(breakpointId)
      expect(doc?.body).toBeTruthy()
    },
    { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
  )
  return doc!
}

/**
 * Wait until `nodeId` is rendered inside the `breakpointId` frame's iframe,
 * then return the element. The node-level companion to
 * `waitForCanvasFrameDocument` for tests that immediately interact with a
 * specific canvas node.
 */
export async function waitForCanvasNodeInFrame<E extends Element = HTMLElement>(
  breakpointId: string,
  nodeId: string,
): Promise<E> {
  let el: E | null = null
  await waitFor(
    () => {
      el = queryCanvasNodeInFrame<E>(breakpointId, nodeId)
      expect(el).toBeTruthy()
    },
    { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
  )
  return el!
}

/**
 * Wait until `selector` matches in any canvas iframe (or the parent document),
 * then return the first match. The frame-agnostic companion to
 * `waitForCanvasNodeInFrame` for tests that don't care which breakpoint frame
 * the element lands in.
 */
export async function waitForCanvasElement<E extends Element = HTMLElement>(
  selector: string,
): Promise<E> {
  let el: E | null = null
  await waitFor(
    () => {
      el = queryCanvasElement<E>(selector)
      expect(el).toBeTruthy()
    },
    { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
  )
  return el!
}
