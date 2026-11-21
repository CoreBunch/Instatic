/**
 * Canvas plugin stylesheets — one shared, live copy of the stylesheets that
 * enabled plugins add to published pages.
 *
 * Every breakpoint frame mounts its own `PluginStylesheetInjector`, so the
 * list is loaded once into a module-level store instead of once per frame.
 * The store loads when the first frame subscribes and reloads on
 * `CMS_PLUGINS_CHANGED_EVENT` (plugin installed, upgraded, enabled, disabled
 * or removed), so the canvas follows plugin changes without a page reload.
 *
 * Which stylesheets a plugin contributes is decided on the server
 * (`server/publish/canvasStylesheets.ts`, sharing the publisher's eligibility
 * rule); this module only fetches and fans out the result.
 */

import { useSyncExternalStore } from 'react'
import { listCmsCanvasPluginStylesheets } from '@core/persistence'
import type { CanvasPluginStylesheet } from '@core/plugins/canvasStylesheets'
import { CMS_PLUGINS_CHANGED_EVENT } from '@plugins/utils/pluginEvents'

const NO_STYLESHEETS: readonly CanvasPluginStylesheet[] = []

let snapshot: readonly CanvasPluginStylesheet[] = NO_STYLESHEETS
let loadSequence = 0
const listeners = new Set<() => void>()

function load(): void {
  const sequence = ++loadSequence
  listCmsCanvasPluginStylesheets()
    .then((stylesheets) => {
      // A newer load superseded this one; its answer is the current truth.
      if (sequence !== loadSequence) return
      snapshot = stylesheets
      for (const listener of listeners) listener()
    })
    .catch((err: unknown) => {
      // The canvas stays usable without plugin styles; keep the last good list.
      console.error('[canvas] Loading plugin stylesheets failed:', err)
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    window.addEventListener(CMS_PLUGINS_CHANGED_EVENT, load)
    load()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener(CMS_PLUGINS_CHANGED_EVENT, load)
  }
}

function getSnapshot(): readonly CanvasPluginStylesheet[] {
  return snapshot
}

export function useCanvasPluginStylesheets(): readonly CanvasPluginStylesheet[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}
