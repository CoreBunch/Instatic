import { ANIMATION_PRESETS } from './animationPresets'

export const SCROLL_ANIMATION_FRAMES = ANIMATION_PRESETS.map(preset => ({
  name: `${preset.value}-scroll`,
  frames: [preset.from, preset.to].map(frame => Object.fromEntries(
    frame.split(';').filter(part => part.trim()).map(part => part.split(':').map(value => value.trim())),
  )),
}))

/** Self-contained: also serialized as a browser asset by the server. */
export function installScrollAnimations(doc: Document, presets: typeof SCROLL_ANIMATION_FRAMES): () => void {
  const win = doc.defaultView
  if (!win || !win.IntersectionObserver || !win.MutationObserver || !win.Element.prototype.animate) return () => {}
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
  const states = new Map<Element, { signature: string; animation: Animation; played: boolean }>()
  let scheduled = 0
  let disposed = false
  const observer = new win.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const state = states.get(entry.target)
      if (!state || state.played) continue
      state.played = true
      state.animation.play()
      observer.unobserve(entry.target)
    }
  }, { threshold: 0 })

  const clear = (element: Element) => {
    const state = states.get(element)
    state?.animation.cancel()
    observer.unobserve(element)
    states.delete(element)
  }
  const scan = () => {
    scheduled = 0
    if (disposed) return
    for (const element of states.keys()) if (!element.isConnected) clear(element)
    for (const element of doc.querySelectorAll('*')) {
      const style = win.getComputedStyle(element)
      const preset = presets.find(item => item.name === style.animationName)
      // No keyframes are defined for the -scroll names in CSS. Without JS,
      // reduced motion, or animation support, authored content stays visible.
      if (!preset || style.display === 'none') { if (states.has(element)) clear(element); continue }
      if (reduced.matches) continue
      const signature = [style.animationName, style.animationDuration, style.animationDelay, style.animationTimingFunction].join('|')
      if (states.get(element)?.signature === signature) continue
      clear(element)
      const animation = element.animate(preset.frames, {
        duration: parseFloat(style.animationDuration) * 1000,
        delay: parseFloat(style.animationDelay) * 1000,
        easing: style.animationTimingFunction,
        fill: 'both',
        iterations: 1,
      })
      animation.pause()
      animation.currentTime = 0
      states.set(element, { signature, animation, played: false })
      observer.observe(element)
    }
  }
  const schedule = () => {
    if (!scheduled && !disposed) scheduled = win.requestAnimationFrame(scan)
  }
  const onReducedMotion = () => {
    if (reduced.matches) {
      for (const [element, state] of states) {
        state.animation.cancel()
        state.played = true
        observer.unobserve(element)
      }
    } else schedule()
  }
  const mutations = new win.MutationObserver(schedule)
  mutations.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  reduced.addEventListener('change', onReducedMotion)
  win.addEventListener('resize', schedule)
  doc.addEventListener('load', schedule, true)
  scan()
  return () => {
    disposed = true
    win.cancelAnimationFrame(scheduled)
    mutations.disconnect()
    observer.disconnect()
    reduced.removeEventListener('change', onReducedMotion)
    win.removeEventListener('resize', schedule)
    doc.removeEventListener('load', schedule, true)
    for (const state of states.values()) state.animation.cancel()
    states.clear()
  }
}
