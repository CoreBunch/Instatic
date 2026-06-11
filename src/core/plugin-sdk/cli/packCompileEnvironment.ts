/**
 * Pack-compile environment for the plugin CLI.
 *
 * `definePack({ layouts })` compiles clean HTML into layout snapshots via the
 * host's HTML-import pipeline, which needs two things Bun doesn't provide:
 *
 *   1. A DOM — `DOMParser` for the markup, `CSSStyleSheet` for the CSS.
 *      Installed from happy-dom, the same approach the server uses for
 *      richtext sanitization (`server/richtextSanitizer.ts`).
 *   2. The base module registry — `walkAndMap` maps HTML elements to
 *      `base.*` modules through `HTML_TO_MODULE_RULES`, which resolves
 *      defaults from the registry.
 *
 * The CLI evaluates the author's `instatic-plugin.config.ts` (where
 * `definePack` runs), so it installs both first. Kept out of the SDK
 * builders themselves so happy-dom and the module bundle never reach a
 * browser bundle through the SDK barrel — only the CLI (which always runs
 * under Bun) imports this module.
 */

import { GlobalWindow } from 'happy-dom'
// Registers every base module on import — same side-effect import the
// editor body and the test suites use.
import '@modules/base'

let installed = false

export function installPackCompileEnvironment(): void {
  if (installed) return
  installed = true
  if (typeof globalThis.DOMParser !== 'undefined') return

  const window = new GlobalWindow({ url: 'http://localhost/' })
  const g = globalThis as Record<string, unknown>
  g.DOMParser = window.DOMParser
  if (typeof globalThis.CSSStyleSheet === 'undefined') {
    g.CSSStyleSheet = window.CSSStyleSheet
  }
}
