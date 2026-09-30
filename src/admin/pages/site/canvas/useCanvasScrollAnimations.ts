import { useEffect } from 'react'
import { installScrollAnimations, SCROLL_ANIMATION_FRAMES } from '@core/scrollAnimationRuntime'
import { useEditorStore } from '@site/store/store'

/** Design mode stays fully visible; Live uses the same observer as publishing. */
export function useCanvasScrollAnimations(doc: Document | null, enabled: boolean) {
  const rules = useEditorStore(state => state.site?.styleRules)
  useEffect(() => {
    if (!doc || !enabled) return
    return installScrollAnimations(doc, SCROLL_ANIMATION_FRAMES)
  }, [doc, enabled, rules])
}
