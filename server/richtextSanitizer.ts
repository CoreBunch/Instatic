/**
 * Server-side DOMPurify runtime for `sanitizeRichtext` / `sanitizeSvg`.
 *
 * Backed by jsdom, the DOM implementation DOMPurify documents and tests
 * against. The previous backend, happy-dom, does not implement the DOM
 * spec's NodeIterator "removing steps": DOMPurify walks the tree with
 * `createNodeIterator()` and removes disallowed nodes as it goes, and under
 * happy-dom the first removal detaches the iterator so `nextNode()` returns
 * null and the walk stops. Every sibling after the first removed node is then
 * emitted unsanitized. Because the richtext profile drops `<img>`, that skip
 * fires on any body carrying an image, so a trailing `<script>` survived into
 * published HTML (stored XSS, GHSA-jg75-xjf8-vvf8). jsdom implements the
 * removing steps, so the walk visits every node.
 */

import DOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'
import {
  configureRichtextSanitizer,
  type DOMPurifyRuntime,
} from '@core/sanitize'

type DOMPurifyFactory = (window: Window) => DOMPurifyRuntime

let installed = false
const serverSanitizerState: { window: Window | null } = { window: null }

export function installServerRichtextSanitizer(): void {
  if (installed) return

  const window = new JSDOM('', { url: 'http://localhost/' }).window as unknown as Window
  serverSanitizerState.window = window
  const createDOMPurify = DOMPurify as unknown as DOMPurifyFactory
  const purifier = createDOMPurify(window)
  configureRichtextSanitizer(purifier)
  installed = true
}

installServerRichtextSanitizer()
