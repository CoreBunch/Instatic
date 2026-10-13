import type {
  VisitorPreferenceName,
  VisitorPreferenceOverrides,
  VisitorPreferencesRuntimeConfig,
} from '@core/visitor-preferences-schema'
import type { ResolvedVisitorPreferences, resolveVisitorPreferences } from './resolve'

export type VisitorPreferenceStatus = 'default' | 'saved' | 'session' | 'reset' | 'unavailable' | 'preview' | 'invalid'
export type VisitorPreferencesValidators = {
  config: (value: unknown) => value is VisitorPreferencesRuntimeConfig
  overrides: (value: unknown) => value is VisitorPreferenceOverrides
  name: (value: unknown) => value is VisitorPreferenceName
}
export type VisitorPreferencesState = ResolvedVisitorPreferences & { status: VisitorPreferenceStatus }
export type VisitorPreferencesChangeEvent = CustomEvent<VisitorPreferencesState>
export type VisitorPreferencesOwner = {
  getState: () => VisitorPreferencesState
  set: (name: VisitorPreferenceName, value: string, origin?: Element) => void
  updateConfig: (value: VisitorPreferencesRuntimeConfig) => void
  subscribe: (listener: () => void) => () => void
}

/**
 * One typed installer for published documents and canvas documents. All
 * dependencies are explicit so its compiled function is a static browser asset.
 */
export function installVisitorPreferences(
  document: Document,
  rawConfig: unknown,
  validators: VisitorPreferencesValidators,
  resolve: typeof resolveVisitorPreferences,
): { owner: VisitorPreferencesOwner; release: () => void } {
  if (!validators.config(rawConfig)) throw new Error('Invalid visitor preference runtime configuration')
  const context = document.defaultView
  if (!context) throw new Error('Visitor preferences require a browser document')
  const window = context
  const host = document as Document & {
    __instaticVisitorPreferences?: { users: number; owner: VisitorPreferencesOwner; dispose: () => void }
  }
  let installation = host.__instaticVisitorPreferences
  if (!installation) {
    const root = document.documentElement
    const original = {
      defaultTheme: root.classList.contains('theme-default'),
      altTheme: root.classList.contains('theme-alt'),
      motion: root.getAttribute('data-instatic-motion'),
      media: root.getAttribute('data-instatic-media'),
    }
    let config = { defaults: { ...rawConfig.defaults }, storage: rawConfig.storage }
    let overrides: VisitorPreferenceOverrides = {}
    let status: VisitorPreferenceStatus = config.storage === 'memory' ? 'preview' : 'default'
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const listeners = new Set<() => void>()
    const managedVideos = new Map<HTMLVideoElement, {
      source: string | null
      preload: HTMLVideoElement['preload']
      autoplay: boolean
      ready: string | null
      onMediaState: (event: Event) => void
    }>()
    const storageKey = 'instatic.site-preferences'
    const controlSelector = '[data-instatic-preference-control]'
    const ElementClass = window.Element

    function getState(): VisitorPreferencesState {
      return { ...resolve(config.defaults, overrides, { dark: dark.matches, reducedMotion: reducedMotion.matches }), status }
    }

    function updateControls(origin?: Element) {
      const state = getState()
      for (const control of document.querySelectorAll<HTMLElement>(controlSelector)) {
        const name = control.getAttribute('data-instatic-preference')
        if (!validators.name(name)) throw new Error('Invalid native preference control name')
        const select = control.querySelector<HTMLSelectElement>('select[data-instatic-preference-value]')
        // The synchronous head owner also sees parser additions while a
        // control's start tag exists but its select has not been parsed yet.
        if (!select) continue
        select.value = state.selected[name]
        select.disabled = false
        const feedback = control.querySelector<HTMLElement>('[data-instatic-preference-feedback]')
        // Only the initiating control announces a user action; repeated controls
        // still reflect the state without announcing the same result twice.
        feedback?.setAttribute('aria-live', control === origin ? 'polite' : 'off')
        for (const caption of control.querySelectorAll<HTMLElement>('[data-instatic-preference-status]')) {
          caption.hidden = caption.getAttribute('data-instatic-preference-status') !== state.status
        }
      }
    }

    function updateDecorativeVideos() {
      const state = getState()
      for (const video of document.querySelectorAll<HTMLVideoElement>('video[data-instatic-decorative-src]')) {
        if (!managedVideos.has(video)) {
          const onMediaState = (event: Event) => {
            if (video.ownerDocument !== document || !video.isConnected || !video.hasAttribute('data-instatic-decorative-src')) return
            const preference = getState()
            const ready = event.type !== 'emptied' && event.type !== 'error' && video.error === null && !preference.reducedMedia && !preference.reducedMotion && video.readyState >= window.HTMLMediaElement.HAVE_CURRENT_DATA
            video.setAttribute('data-instatic-decorative-ready', String(ready))
          }
          managedVideos.set(video, { source: video.getAttribute('src'), preload: video.preload, autoplay: video.autoplay, ready: video.getAttribute('data-instatic-decorative-ready'), onMediaState })
          for (const name of ['loadeddata', 'emptied', 'error']) video.addEventListener(name, onMediaState)
        }
        const source = video.getAttribute('data-instatic-decorative-src')
        if (!source) throw new Error('Native decorative video is missing its source')
        if (state.reducedMedia || state.reducedMotion) {
          video.setAttribute('data-instatic-decorative-ready', 'false')
          video.autoplay = false
          video.preload = 'none'
          if (video.hasAttribute('src')) {
            video.pause()
            video.removeAttribute('src')
            video.load()
          }
        } else {
          video.setAttribute('preload', video.getAttribute('data-instatic-decorative-preload') ?? 'none')
          video.autoplay = video.getAttribute('data-instatic-decorative-autoplay') === 'true'
          if (video.getAttribute('src') !== source) {
            video.setAttribute('data-instatic-decorative-ready', 'false')
            video.setAttribute('src', source)
            video.load()
          } else {
            video.setAttribute('data-instatic-decorative-ready', String(video.error === null && video.readyState >= window.HTMLMediaElement.HAVE_CURRENT_DATA))
          }
        }
      }
      for (const [video, previous] of managedVideos) {
        if (video.ownerDocument !== document || !video.hasAttribute('data-instatic-decorative-src')) {
          // A content-role transition or another document owns the element now.
          for (const name of ['loadeddata', 'emptied', 'error']) video.removeEventListener(name, previous.onMediaState)
          if (video.ownerDocument === document) video.removeAttribute('data-instatic-decorative-ready')
          managedVideos.delete(video)
        } else if (!video.isConnected) {
          // Removing a media element does not itself stop its playback/download.
          video.pause()
          video.autoplay = false
          video.preload = 'none'
          video.removeAttribute('src')
          video.load()
          for (const name of ['loadeddata', 'emptied', 'error']) video.removeEventListener(name, previous.onMediaState)
          video.removeAttribute('data-instatic-decorative-ready')
          managedVideos.delete(video)
        }
      }
    }

    function apply(origin?: Element) {
      const state = getState()
      root.classList.toggle('theme-default', state.theme === 'default')
      root.classList.toggle('theme-alt', state.theme === 'alt')
      root.setAttribute('data-instatic-motion', state.reducedMotion ? 'reduced' : 'full')
      root.setAttribute('data-instatic-media', state.reducedMedia ? 'reduced' : 'full')
      updateControls(origin)
      updateDecorativeVideos()
      for (const listener of listeners) listener()
      document.dispatchEvent(new window.CustomEvent('instatic:visitor-preferences-change', { detail: state }))
    }

    function readStored(raw: string | null) {
      overrides = {}
      if (raw === null) { status = 'default'; return }
      try {
        const value: unknown = JSON.parse(raw)
        if (!validators.overrides(value)) throw new Error('Stored visitor preferences do not match their schema')
        overrides = value
        status = 'saved'
      } catch (error) {
        status = 'reset'
        console.warn('[visitor-preferences] Invalid stored preferences; explicit defaults restored:', error)
        try { window.localStorage.removeItem(storageKey) } catch (storageError) {
          status = 'unavailable'
          console.error('[visitor-preferences] Cannot remove invalid stored preferences:', storageError)
        }
      }
    }

    if (config.storage === 'persistent') {
      try { readStored(window.localStorage.getItem(storageKey)) } catch (error) {
        status = 'unavailable'
        console.error('[visitor-preferences] Cannot read stored preferences:', error)
      }
    }

    function set(name: VisitorPreferenceName, value: string, origin?: Element) {
      const next = { ...overrides, [name]: value }
      if (!validators.overrides(next)) throw new Error('Invalid visitor preference choice')
      overrides = next
      if (config.storage === 'memory') status = 'preview'
      else {
        try { window.localStorage.setItem(storageKey, JSON.stringify(overrides)); status = 'saved' } catch (error) {
          status = 'session'
          console.error('[visitor-preferences] Cannot save preferences; current document only:', error)
        }
      }
      apply(origin)
    }

    function onChange(event: Event) {
      const path = event.composedPath()
      const control = path.find((item): item is Element => item instanceof ElementClass && item.matches(controlSelector))
      if (!control || !path.some(item => item instanceof ElementClass && item.matches('select[data-instatic-preference-value]'))) return
      const name = control.getAttribute('data-instatic-preference')
      const select = control.querySelector<HTMLSelectElement>('select[data-instatic-preference-value]')
      try {
        if (!validators.name(name) || !select) throw new Error('Invalid native preference control')
        set(name, select.value, control)
      } catch (error) {
        status = 'invalid'
        console.error('[visitor-preferences] Cannot apply control choice:', error)
        apply(control)
      }
    }

    function onSystemChange() { apply() }
    function onStorage(event: StorageEvent) {
      if (config.storage !== 'persistent' || (event.key !== storageKey && event.key !== null)) return
      try { if (event.storageArea !== window.localStorage) return } catch (error) {
        status = 'unavailable'
        console.error('[visitor-preferences] Cannot synchronize saved preferences:', error)
        apply()
        return
      }
      readStored(event.newValue)
      apply()
    }

    const observer = new window.MutationObserver(() => { updateControls(); updateDecorativeVideos() })
    observer.observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-instatic-decorative-src', 'data-instatic-decorative-preload', 'data-instatic-decorative-autoplay', 'data-instatic-preference'],
    })
    document.addEventListener('change', onChange)
    dark.addEventListener('change', onSystemChange)
    reducedMotion.addEventListener('change', onSystemChange)
    window.addEventListener('storage', onStorage)
    const owner: VisitorPreferencesOwner = {
      getState,
      set,
      updateConfig(next) {
        if (!validators.config(next)) throw new Error('Invalid visitor preference runtime configuration')
        if (config.storage !== next.storage) throw new Error('A preference document cannot change its persistence mode')
        config = { defaults: { ...next.defaults }, storage: next.storage }
        apply()
      },
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    installation = {
      users: 0,
      owner,
      dispose() {
        observer.disconnect()
        document.removeEventListener('change', onChange)
        dark.removeEventListener('change', onSystemChange)
        reducedMotion.removeEventListener('change', onSystemChange)
        window.removeEventListener('storage', onStorage)
        listeners.clear()
        for (const [video, originalVideo] of managedVideos) {
          for (const name of ['loadeddata', 'emptied', 'error']) video.removeEventListener(name, originalVideo.onMediaState)
          if (video.ownerDocument !== document) continue
          if (!video.hasAttribute('data-instatic-decorative-src')) {
            video.removeAttribute('data-instatic-decorative-ready')
            continue
          }
          if (originalVideo.ready === null) video.removeAttribute('data-instatic-decorative-ready')
          else video.setAttribute('data-instatic-decorative-ready', originalVideo.ready)
          video.pause()
          if (originalVideo.source === null) video.removeAttribute('src')
          else video.setAttribute('src', originalVideo.source)
          video.preload = originalVideo.preload
          video.autoplay = originalVideo.autoplay
          video.load()
        }
        managedVideos.clear()
        root.classList.toggle('theme-default', original.defaultTheme)
        root.classList.toggle('theme-alt', original.altTheme)
        for (const [attribute, value] of [['data-instatic-motion', original.motion], ['data-instatic-media', original.media]] as const) {
          if (value === null) root.removeAttribute(attribute)
          else root.setAttribute(attribute, value)
        }
        delete host.__instaticVisitorPreferences
      },
    }
    host.__instaticVisitorPreferences = installation
    apply()
  } else installation.owner.updateConfig(rawConfig)

  installation.users += 1
  const installed = installation
  let released = false
  return {
    owner: installed.owner,
    release() {
      if (released) return
      released = true
      installed.users -= 1
      if (installed.users === 0) installed.dispose()
    },
  }
}
