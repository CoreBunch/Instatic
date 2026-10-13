import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalWindow } from 'happy-dom'
import { PreferenceModule } from '@modules/base/preference'
import {
  installVisitorPreferences, resolveVisitorPreferences, visitorPreferencesValidators,
  VISITOR_PREFERENCES_RUNTIME_JS, VISITOR_PREFERENCES_CONFIG_ATTRIBUTE,
} from '@core/visitor-preferences'
import { DEFAULT_SITE_VISITOR_PREFERENCES } from '@core/visitor-preferences-schema'

const releases: Array<() => void> = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
  document.body.replaceChildren()
  document.documentElement.removeAttribute(VISITOR_PREFERENCES_CONFIG_ATTRIBUTE)
})

describe('native preference document owner', () => {
  const mediaConstant = Object.getOwnPropertyDescriptor(window.HTMLMediaElement, 'HAVE_CURRENT_DATA')
  beforeAll(() => {
    // Happy DOM omits media ready-state constants; install the browser's value in this test realm.
    Object.defineProperty(window.HTMLMediaElement, 'HAVE_CURRENT_DATA', { value: 2, configurable: true })
  })
  afterAll(() => {
    if (mediaConstant) Object.defineProperty(window.HTMLMediaElement, 'HAVE_CURRENT_DATA', mediaConstant)
    else Reflect.deleteProperty(window.HTMLMediaElement, 'HAVE_CURRENT_DATA')
  })
  function attach() {
    const lease = installVisitorPreferences(document, { defaults: DEFAULT_SITE_VISITOR_PREFERENCES, storage: 'memory' }, visitorPreferencesValidators, resolveVisitorPreferences)
    releases.push(lease.release)
    return lease.owner
  }

  it('shares state across leases and restores document attributes after final cleanup', () => {
    const before = document.documentElement.className
    const first = attach()
    const second = attach()
    expect(first).toBe(second)
    first.set('theme', 'alt')
    expect(second.getState().theme).toBe('alt')
    expect(document.documentElement.classList.contains('theme-alt')).toBe(true)
    expect(first.getState().status).toBe('preview')
    releases.shift()!()
    expect(document.documentElement.classList.contains('theme-alt')).toBe(true)
    releases.shift()!()
    expect(document.documentElement.className).toBe(before)
  })

  it('rejects undeclared values instead of correcting them silently', () => {
    const owner = attach()
    expect(() => owner.set('theme', 'eco')).toThrow('Invalid visitor preference choice')
    expect(owner.getState().selected.theme).toBe('system')
    expect(() => installVisitorPreferences(document, { defaults: { theme: 'eco' }, storage: 'memory' }, visitorPreferencesValidators, resolveVisitorPreferences)).toThrow('Invalid visitor preference runtime configuration')
  })

  it('emits the same installer and TypeBox validators as static self-contained browser code', () => {
    document.documentElement.setAttribute(VISITOR_PREFERENCES_CONFIG_ATTRIBUTE, JSON.stringify({ defaults: DEFAULT_SITE_VISITOR_PREFERENCES, storage: 'memory' }))
    const execute = new Function('document', 'return ' + VISITOR_PREFERENCES_RUNTIME_JS)
    const lease = execute(document) as { release: () => void }
    releases.push(lease.release)
    expect(document.documentElement.getAttribute('data-instatic-motion')).toBe('full')
    const owner = attach()
    owner.set('media', 'reduced')
    expect(document.documentElement.getAttribute('data-instatic-media')).toBe('reduced')
  })

  it('updates two controls, announces only the initiator, and initializes late hole content', async () => {
    const markup = PreferenceModule.render(PreferenceModule.defaults, []).html
    document.body.innerHTML = markup + markup
    const owner = attach()
    const [first, second] = document.querySelectorAll<HTMLSelectElement>('select')
    first!.value = 'alt'
    first!.dispatchEvent(new window.Event('change', { bubbles: true }))
    expect(second!.value).toBe('alt')
    const feedback = document.querySelectorAll('[data-instatic-preference-feedback]')
    expect(feedback[0]!.getAttribute('aria-live')).toBe('polite')
    expect(feedback[1]!.getAttribute('aria-live')).toBe('off')
    document.body.insertAdjacentHTML('beforeend', markup)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelectorAll<HTMLSelectElement>('select')[2]!.value).toBe('alt')
    expect(owner.getState().status).toBe('preview')
  })

  it('owns decorative loading and playback independently, retaining content and posters', () => {
    document.body.innerHTML = '<video data-instatic-decorative-src="/intro.webm" data-instatic-decorative-preload="auto" data-instatic-decorative-autoplay="true" preload="none" poster="/poster.jpg"></video><video src="/content.webm" controls preload="metadata"></video>'
    const owner = attach()
    const [decorative, content] = document.querySelectorAll<HTMLVideoElement>('video')
    expect(decorative!.getAttribute('src')).toBe('/intro.webm')
    expect(decorative!.autoplay).toBe(true)
    owner.set('media', 'reduced')
    expect(decorative!.hasAttribute('src')).toBe(false)
    expect(decorative!.preload).toBe('none')
    expect(decorative!.autoplay).toBe(false)
    expect(decorative!.getAttribute('poster')).toBe('/poster.jpg')
    expect(content!.getAttribute('src')).toBe('/content.webm')
    expect(content!.controls).toBe(true)
    owner.set('media', 'full')
    expect(decorative!.getAttribute('src')).toBe('/intro.webm')
    owner.set('motion', 'reduced')
    expect(decorative!.hasAttribute('src')).toBe(false)
    expect(content!.getAttribute('src')).toBe('/content.webm')
  })

  it('releases removed decorative media and stops managing a content-role transition', async () => {
    document.body.innerHTML = '<video data-instatic-decorative-src="/intro.webm" data-instatic-decorative-preload="auto" data-instatic-decorative-autoplay="true"></video>'
    const owner = attach()
    const video = document.querySelector('video')!
    video.remove()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(video.getAttribute('src')).toBeNull()
    expect(video.preload).toBe('none')
    expect(video.autoplay).toBe(false)

    document.body.appendChild(video)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(video.getAttribute('src')).toBe('/intro.webm')
    video.removeAttribute('data-instatic-decorative-src')
    video.setAttribute('src', '/ordinary-content.webm')
    await new Promise(resolve => setTimeout(resolve, 0))
    owner.set('media', 'reduced')
    expect(video.getAttribute('src')).toBe('/ordinary-content.webm')
  })

  it('exposes frame readiness without enabling media against visitor policy', () => {
    document.body.innerHTML = '<video data-instatic-decorative-src="/intro.webm" data-instatic-decorative-ready="false"></video><video src="/content.webm"></video>'
    const [video, content] = document.querySelectorAll<HTMLVideoElement>('video')
    let readyState = 0
    Object.defineProperty(video!, 'readyState', { get: () => readyState })
    const owner = attach()
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('false')
    readyState = window.HTMLMediaElement.HAVE_CURRENT_DATA
    video!.dispatchEvent(new Event('loadeddata'))
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('true')
    expect(content!.hasAttribute('data-instatic-decorative-ready')).toBe(false)
    video!.dispatchEvent(new Event('error'))
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('false')
    video!.dispatchEvent(new Event('loadeddata'))
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('true')
    owner.set('media', 'reduced')
    video!.dispatchEvent(new Event('loadeddata'))
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('false')
    expect(video!.hasAttribute('src')).toBe(false)
    owner.set('media', 'full')
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('false')
    video!.dispatchEvent(new Event('loadeddata'))
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('true')
    video!.dispatchEvent(new Event('emptied'))
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('false')
    releases.pop()!()
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('false')
    video!.dispatchEvent(new Event('loadeddata'))
    expect(video!.getAttribute('data-instatic-decorative-ready')).toBe('false')
  })

  it('clears frame readiness on source replacement and relinquishes event ownership', async () => {
    document.body.innerHTML = '<video data-instatic-decorative-src="/intro.webm"></video>'
    const video = document.querySelector('video')!
    Object.defineProperty(video, 'readyState', { value: window.HTMLMediaElement.HAVE_CURRENT_DATA })
    attach()
    video.dispatchEvent(new Event('loadeddata'))
    expect(video.getAttribute('data-instatic-decorative-ready')).toBe('true')
    video.setAttribute('data-instatic-decorative-src', '/replacement.webm')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(video.getAttribute('src')).toBe('/replacement.webm')
    expect(video.getAttribute('data-instatic-decorative-ready')).toBe('false')
    video.removeAttribute('data-instatic-decorative-src')
    releases.pop()!()
    expect(video.hasAttribute('data-instatic-decorative-ready')).toBe(false)
    video.dispatchEvent(new Event('loadeddata'))
    expect(video.hasAttribute('data-instatic-decorative-ready')).toBe(false)
  })

  it('preserves a content-role transition even when cleanup precedes the mutation observer', () => {
    document.body.innerHTML = '<video data-instatic-decorative-src="/intro.webm"></video>'
    attach()
    const video = document.querySelector('video')!
    video.removeAttribute('data-instatic-decorative-src')
    video.setAttribute('src', '/ordinary-content.webm')
    releases.pop()!()
    expect(video.getAttribute('src')).toBe('/ordinary-content.webm')
  })

  it('distinguishes malformed stored choices from unavailable persistence and session-only changes', () => {
    const local = new GlobalWindow({ url: 'http://localhost/preferences-test' })
    local.localStorage.setItem('instatic.site-preferences', '{bad')
    const reset = installVisitorPreferences(local.document, { defaults: DEFAULT_SITE_VISITOR_PREFERENCES, storage: 'persistent' }, visitorPreferencesValidators, resolveVisitorPreferences)
    expect(reset.owner.getState().status).toBe('reset')
    expect(local.localStorage.getItem('instatic.site-preferences')).toBeNull()
    reset.release()
    const inaccessible = new GlobalWindow({ url: 'http://localhost/preferences-unavailable' })
    Object.defineProperty(inaccessible, 'localStorage', { get() { throw new Error('Storage blocked') } })
    const session = installVisitorPreferences(inaccessible.document, { defaults: DEFAULT_SITE_VISITOR_PREFERENCES, storage: 'persistent' }, visitorPreferencesValidators, resolveVisitorPreferences)
    expect(session.owner.getState().status).toBe('unavailable')
    session.owner.set('theme', 'alt')
    expect(session.owner.getState().theme).toBe('alt')
    expect(session.owner.getState().status).toBe('session')
    session.release()
  })

  it('does not access visitor storage from the canvas memory mode', () => {
    const canvas = new GlobalWindow({ url: 'http://localhost/canvas' })
    Object.defineProperty(canvas, 'localStorage', { get() { throw new Error('Canvas accessed public storage') } })
    const lease = installVisitorPreferences(canvas.document, { defaults: DEFAULT_SITE_VISITOR_PREFERENCES, storage: 'memory' }, visitorPreferencesValidators, resolveVisitorPreferences)
    lease.owner.set('theme', 'alt')
    expect(lease.owner.getState().status).toBe('preview')
    lease.release()
  })
})
