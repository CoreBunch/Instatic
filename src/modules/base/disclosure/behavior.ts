/**
 * The same typed installer runs in the canvas and becomes the module's vanilla
 * browser asset. Keep it self-contained: its compiled function body is emitted
 * by disclosureRuntimeJs.ts without a bundler or a second implementation.
 */
export function installDisclosureBehavior(document: Document): () => void {
  const host = document as Document & {
    __instaticDisclosureBehavior?: { users: number; dispose: () => void }
  }
  let state = host.__instaticDisclosureBehavior
  if (!state) {
    const selector = 'details[data-instatic-disclosure]'
    const ElementClass = document.defaultView?.Element
    if (!ElementClass) throw new Error('Disclosure behavior requires a browser document')

    function summary(details: HTMLDetailsElement): HTMLElement | undefined {
      return Array.from(details.children).find((child) => child.tagName === 'SUMMARY') as HTMLElement | undefined
    }

    function close(details: HTMLDetailsElement, returnFocus: boolean) {
      const trigger = summary(details)
      const focusIsInside = document.activeElement !== trigger && details.contains(document.activeElement)
      details.open = false
      if (returnFocus || focusIsInside) trigger?.focus({ preventScroll: true })
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const details = event.composedPath().find((item): item is HTMLDetailsElement =>
        item instanceof ElementClass! && item.matches(selector + '[open]'))
      if (!details || details.getAttribute('data-instatic-close-on-escape') !== 'true') return
      event.preventDefault()
      event.stopPropagation()
      close(details, true)
    }

    function onPointerDown(event: PointerEvent) {
      if (event.button !== 0 || event.defaultPrevented) return
      const path = event.composedPath()
      for (const details of Array.from(document.querySelectorAll<HTMLDetailsElement>(selector + '[open]')).reverse()) {
        if (details.getAttribute('data-instatic-close-on-outside-pointer') === 'true' && !path.includes(details)) {
          close(details, false)
        }
      }
    }

    function onFocusIn(event: FocusEvent) {
      const path = event.composedPath()
      for (const details of document.querySelectorAll<HTMLDetailsElement>(selector + '[open]')) {
        if (details.getAttribute('data-instatic-close-on-focus-leave') === 'true' && !path.includes(details)) {
          close(details, false)
        }
      }
    }

    function onToggle(event: Event) {
      const details = event.target
      if (!(details instanceof ElementClass!) || !details.matches(selector) || details.hasAttribute('open')) return
      const trigger = summary(details as HTMLDetailsElement)
      // Native group exclusivity or another script may close a disclosure while
      // its panel has focus. Never leave keyboard focus in concealed content.
      if (document.activeElement !== trigger && details.contains(document.activeElement)) trigger?.focus({ preventScroll: true })
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('toggle', onToggle, true)
    state = {
      users: 0,
      dispose() {
        document.removeEventListener('keydown', onKeyDown)
        document.removeEventListener('pointerdown', onPointerDown)
        document.removeEventListener('focusin', onFocusIn)
        document.removeEventListener('toggle', onToggle, true)
        delete host.__instaticDisclosureBehavior
      },
    }
    host.__instaticDisclosureBehavior = state
  }
  state.users += 1
  const installed = state
  let released = false
  return () => {
    if (released) return
    released = true
    installed.users -= 1
    if (installed.users === 0) installed.dispose()
  }
}
