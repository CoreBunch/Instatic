import { afterEach, expect, it, spyOn } from 'bun:test'
import { installScrollAnimations, SCROLL_ANIMATION_FRAMES } from '@core/scrollAnimationRuntime'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.reverse().forEach(cleanup => cleanup()); cleanups.length = 0; document.body.innerHTML = '' })

function harness(reduced = false) {
  const win = document.defaultView!
  let intersect: (element: Element) => void = () => {}
  let changed: () => void = () => {}
  const animations: { pause: ReturnType<typeof spyOn>; play: ReturnType<typeof spyOn>; cancel: ReturnType<typeof spyOn> }[] = []
  const media = { matches: reduced, addEventListener: (_name: string, callback: () => void) => { changed = callback }, removeEventListener: () => {} }
  const properties = ['IntersectionObserver', 'matchMedia'] as const
  const descriptors = properties.map(name => Object.getOwnPropertyDescriptor(win, name))
  properties.forEach((name, index) => cleanups.push(() => {
    const descriptor = descriptors[index]
    if (descriptor) Object.defineProperty(win, name, descriptor)
    else Reflect.deleteProperty(win, name)
  }))
  Object.defineProperty(win, 'matchMedia', { configurable: true, value: () => media })
  Object.defineProperty(win, 'IntersectionObserver', { configurable: true, value: class {
    constructor(callback: IntersectionObserverCallback) {
      intersect = element => callback([{ target: element, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } })
  const originalAnimate = Object.getOwnPropertyDescriptor(win.Element.prototype, 'animate')
  Object.defineProperty(win.Element.prototype, 'animate', { configurable: true, value: () => {
    const animation = { currentTime: 0, pause() {}, play() {}, cancel() {} }
    const calls = { pause: spyOn(animation, 'pause'), play: spyOn(animation, 'play'), cancel: spyOn(animation, 'cancel') }
    animations.push(calls)
    return animation
  } })
  cleanups.push(() => {
    if (originalAnimate) Object.defineProperty(win.Element.prototype, 'animate', originalAnimate)
    else Reflect.deleteProperty(win.Element.prototype, 'animate')
  })
  const element = document.createElement('div')
  element.style.animationName = 'instatic-slide-up-scroll'
  element.style.animationDuration = '0.6s'
  element.style.animationDelay = '0.15s'
  element.style.animationTimingFunction = 'ease-out'
  document.body.append(element)
  const stop = installScrollAnimations(document, SCROLL_ANIMATION_FRAMES)
  cleanups.push(stop)
  return { element, animations, intersect: () => intersect(element), reduce: () => { media.matches = true; changed() }, stop }
}

it('waits for intersection and starts only once', () => {
  const test = harness()
  expect(test.animations).toHaveLength(1)
  expect(test.animations[0].pause).toHaveBeenCalledTimes(1)
  expect(test.animations[0].play).not.toHaveBeenCalled()
  test.intersect()
  test.intersect()
  expect(test.animations[0].play).toHaveBeenCalledTimes(1)
})

it('does not hide content for reduced motion', () => {
  const test = harness(true)
  expect(test.animations).toHaveLength(0)
})

it('discovers entries inserted after the initial render', async () => {
  const test = harness()
  document.body.append(test.element.cloneNode())
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(test.animations).toHaveLength(2)
  expect(test.animations[1].play).not.toHaveBeenCalled()
})

it('cancels pending effects on a reduced-motion change or cleanup', () => {
  const test = harness()
  test.reduce()
  expect(test.animations[0].cancel).toHaveBeenCalledTimes(1)
  test.intersect()
  expect(test.animations[0].play).not.toHaveBeenCalled()
  test.stop()
  expect(test.animations[0].cancel).toHaveBeenCalledTimes(2)
})
