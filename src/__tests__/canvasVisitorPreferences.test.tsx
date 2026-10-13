import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import { GlobalWindow } from 'happy-dom'
import { CanvasVisitorPreferences } from '@site/canvas/CanvasVisitorPreferences'
import { useEditorStore } from '@site/store/store'
import { DEFAULT_SITE_VISITOR_PREFERENCES } from '@core/visitor-preferences-schema'
import { VISITOR_PREFERENCES_CONFIG_ATTRIBUTE } from '@core/visitor-preferences'
import { makeSite } from './publisher/helpers'

describe('canvas visitor preference lifetime', () => {
  it('releases the replaced frame and keeps one owner in the replacement document', () => {
    const originalSite = useEditorStore.getState().site
    const first = new GlobalWindow({ url: 'http://localhost/first-frame' })
    const second = new GlobalWindow({ url: 'http://localhost/second-frame' })
    for (const frame of [first, second]) {
      Object.defineProperty(frame, 'localStorage', { get() { throw new Error('Canvas accessed visitor storage') } })
    }
    useEditorStore.setState({ site: makeSite({ settings: { shortcuts: {}, visitorPreferences: DEFAULT_SITE_VISITOR_PREFERENCES } }) })
    const canvas = render(<CanvasVisitorPreferences targetDocument={first.document} />)
    try {
      const selector = 'style[data-source="CanvasVisitorPreferences"]'
      expect(first.document.documentElement.getAttribute('data-instatic-motion')).toBe('full')
      expect(first.document.querySelectorAll(selector)).toHaveLength(1)

      canvas.rerender(<CanvasVisitorPreferences targetDocument={second.document} />)
      expect(first.document.documentElement.hasAttribute(VISITOR_PREFERENCES_CONFIG_ATTRIBUTE)).toBe(false)
      expect(first.document.documentElement.hasAttribute('data-instatic-motion')).toBe(false)
      expect(first.document.querySelector(selector)).toBeNull()
      expect(second.document.documentElement.getAttribute('data-instatic-motion')).toBe('full')
      expect(second.document.querySelectorAll(selector)).toHaveLength(1)

      canvas.unmount()
      expect(second.document.documentElement.hasAttribute(VISITOR_PREFERENCES_CONFIG_ATTRIBUTE)).toBe(false)
      expect(second.document.documentElement.hasAttribute('data-instatic-motion')).toBe(false)
      expect(second.document.querySelector(selector)).toBeNull()
    } finally {
      canvas.unmount()
      useEditorStore.setState({ site: originalSite })
    }
  })
})
