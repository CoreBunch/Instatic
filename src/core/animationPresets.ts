/** Shared names and keyframes for the editor's entrance-animation presets. */
export const ANIMATION_PRESETS = [
  { value: 'instatic-fade-in', label: 'Fade in', from: 'opacity: 0;', to: 'opacity: 1;' },
  { value: 'instatic-slide-up', label: 'Slide up', from: 'opacity: 0; translate: 0 24px;', to: 'opacity: 1; translate: 0 0;' },
  { value: 'instatic-slide-down', label: 'Slide down', from: 'opacity: 0; translate: 0 -24px;', to: 'opacity: 1; translate: 0 0;' },
  { value: 'instatic-slide-left', label: 'Slide from right', from: 'opacity: 0; translate: 24px 0;', to: 'opacity: 1; translate: 0 0;' },
  { value: 'instatic-slide-right', label: 'Slide from left', from: 'opacity: 0; translate: -24px 0;', to: 'opacity: 1; translate: 0 0;' },
  { value: 'instatic-zoom-in', label: 'Zoom in', from: 'opacity: 0; scale: .96;', to: 'opacity: 1; scale: 1;' },
] as const

export function parseAnimationPreset(value: string) {
  const match = /^(instatic-[\w-]+) (\d+)ms (ease|ease-in|ease-out|ease-in-out|linear) (\d+)ms 1 both$/.exec(value)
  if (!match) return null
  const trigger = match[1].endsWith('-scroll') ? 'scroll' : 'load'
  const name = trigger === 'scroll' ? match[1].slice(0, -7) : match[1]
  if (!ANIMATION_PRESETS.some(preset => preset.value === name)) return null
  return { name, trigger, duration: Number(match[2]), easing: match[3], delay: Number(match[4]) }
}

/** Only ship presets actually referenced by the emitted stylesheet. */
export function animationPresetCss(css: string): string {
  return ANIMATION_PRESETS.filter(preset => new RegExp(`\\b${preset.value}(?![\\w-])`).test(css))
    .map(preset => {
      const frames = `@keyframes ${preset.value} { from { ${preset.from} } to { ${preset.to} } }`
      // Override the keyframes themselves, so specificity and !important on
      // authored animation declarations cannot defeat reduced-motion settings.
      // No transform is used: entrance motion preserves an authored transform.
      const reduced = `@media (prefers-reduced-motion: reduce) { @keyframes ${preset.value} { from { ${preset.to} } to { ${preset.to} } } }`
      return `${frames}\n${reduced}`
    }).join('\n')
}
