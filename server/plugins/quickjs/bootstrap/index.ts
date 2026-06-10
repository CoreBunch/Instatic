/**
 * BOOTSTRAP_SOURCE — the complete JavaScript source evaluated inside every
 * plugin QuickJS VM before any plugin code runs.
 *
 * Assembled from focused sub-modules to keep each concern independently
 * readable. The Web-Platform polyfills (URL, TextEncoder, console,
 * AbortController, timers, crypto.subtle, fetch) are pure-JS string shims; the
 * API + runners layer is authored as real TypeScript under `src/` and bundled
 * to the committed artifact `generated/pluginBootstrap.ts` by
 * `scripts/sync-plugin-bootstrap.ts` (regenerate with `bun run bootstrap:sync`).
 *
 * Execution order matters: polyfills must be defined before the API layer
 * references them (URL, TextEncoder, AbortController, crypto.subtle, fetch),
 * and the shared base64 codec must precede crypto, fetch, and the bundled
 * runtime — all three move binary payloads through it.
 * The leading `'use strict';` makes the entire evaluated program — including
 * the bundled IIFE — strict.
 */

import { URL_POLYFILL, TEXT_CODEC_POLYFILL, CONSOLE_POLYFILL, ABORT_CONTROLLER_POLYFILL } from './polyfills'
import { TIMERS_SOURCE } from './timers'
import { BASE64_SHIM } from './base64'
import { CRYPTO_SUBTLE_SHIM } from './crypto'
import { FETCH_SHIM } from './fetch'
import { PLUGIN_BOOTSTRAP_SOURCE } from './generated/pluginBootstrap'

export const BOOTSTRAP_SOURCE =
  `\n'use strict';\n\n` +
  URL_POLYFILL +
  TEXT_CODEC_POLYFILL +
  CONSOLE_POLYFILL +
  TIMERS_SOURCE +
  ABORT_CONTROLLER_POLYFILL +
  BASE64_SHIM +
  CRYPTO_SUBTLE_SHIM +
  FETCH_SHIM +
  PLUGIN_BOOTSTRAP_SOURCE
