import { useEffectEvent, useLayoutEffect, useRef } from 'react'
import { useEditorStore } from '@site/store/store'
import {
  installVisitorPreferences, resolveVisitorPreferences, visitorPreferencesValidators,
  VISITOR_PREFERENCES_CONFIG_ATTRIBUTE, VISITOR_PREFERENCES_DOCUMENT_CSS,
} from '@core/visitor-preferences'

/** One memory-only document owner per canvas frame, independent of node count. */
export function CanvasVisitorPreferences({ targetDocument }: { targetDocument: Document }) {
  const defaults = useEditorStore(state => state.site?.settings.visitorPreferences)
  const installed = useRef<{ lease: ReturnType<typeof installVisitorPreferences>; style: HTMLStyleElement; originalConfig: string | null } | null>(null)
  const dispose = useEffectEvent(() => {
    const state = installed.current
    if (!state) return
    state.lease.release()
    state.style.remove()
    const root = state.style.ownerDocument.documentElement
    if (state.originalConfig === null) root.removeAttribute(VISITOR_PREFERENCES_CONFIG_ATTRIBUTE)
    else root.setAttribute(VISITOR_PREFERENCES_CONFIG_ATTRIBUTE, state.originalConfig)
    installed.current = null
  })
  // Frame replacement releases the old document before installing in the new
  // one. A passive cleanup would run after that installation and remove it.
  useLayoutEffect(() => () => { dispose() }, [targetDocument])
  useLayoutEffect(() => {
    if (!defaults) { dispose(); return }
    const config = { defaults, storage: 'memory' } as const
    const root = targetDocument.documentElement
    if (installed.current) {
      installed.current.lease.owner.updateConfig(config)
      root.setAttribute(VISITOR_PREFERENCES_CONFIG_ATTRIBUTE, JSON.stringify(config))
    } else {
      const originalConfig = root.getAttribute(VISITOR_PREFERENCES_CONFIG_ATTRIBUTE)
      const style = targetDocument.createElement('style')
      style.textContent = VISITOR_PREFERENCES_DOCUMENT_CSS
      style.setAttribute('data-source', 'CanvasVisitorPreferences')
      root.setAttribute(VISITOR_PREFERENCES_CONFIG_ATTRIBUTE, JSON.stringify(config))
      targetDocument.head.appendChild(style)
      installed.current = { lease: installVisitorPreferences(targetDocument, config, visitorPreferencesValidators, resolveVisitorPreferences), style, originalConfig }
    }
  }, [defaults, targetDocument])
  return null
}
