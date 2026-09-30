import { installScrollAnimations, SCROLL_ANIMATION_FRAMES } from '@core/scrollAnimationRuntime'

export const SCROLL_ANIMATION_RUNTIME_JS = `(${installScrollAnimations.toString()})(document,${JSON.stringify(SCROLL_ANIMATION_FRAMES)});`
