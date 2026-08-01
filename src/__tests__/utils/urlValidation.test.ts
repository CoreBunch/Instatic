import { describe, it, expect } from 'bun:test'
import { isValidUrl, isValidImageUrl } from '@core/utils/urlValidation'

// ---------------------------------------------------------------------------
// isValidUrl
// ---------------------------------------------------------------------------

describe('isValidUrl', () => {
  describe('empty / falsy values', () => {
    it('returns true for empty string (optional field)', () => {
      expect(isValidUrl('')).toBe(true)
    })
  })

  describe('allowed protocols', () => {
    it('accepts https:', () => {
      expect(isValidUrl('https://example.com')).toBe(true)
    })

    it('accepts https: with path and query', () => {
      expect(isValidUrl('https://example.com/path?q=1#hash')).toBe(true)
    })

    it('accepts http:', () => {
      expect(isValidUrl('http://example.com')).toBe(true)
    })

    it('accepts mailto:', () => {
      expect(isValidUrl('mailto:user@example.com')).toBe(true)
    })
  })

  describe('rejected protocols', () => {
    it('rejects javascript:', () => {
      expect(isValidUrl('javascript:alert(1)')).toBe(false)
    })

    it('rejects data:text/html', () => {
      expect(isValidUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    })

    it('rejects data:image/ (not appropriate for general URLs)', () => {
      expect(isValidUrl('data:image/png;base64,abc')).toBe(false)
    })

    it('rejects ftp:', () => {
      expect(isValidUrl('ftp://files.example.com')).toBe(false)
    })

    it('rejects blob:', () => {
      expect(isValidUrl('blob:https://example.com/abc-123')).toBe(false)
    })

    it('rejects file:', () => {
      expect(isValidUrl('file:///etc/passwd')).toBe(false)
    })

    it('rejects custom scheme', () => {
      expect(isValidUrl('myapp://action')).toBe(false)
    })
  })

  describe('relative references', () => {
    it('accepts a root-relative path', () => {
      expect(isValidUrl('/relative/path')).toBe(true)
    })

    it('accepts document-relative paths', () => {
      expect(isValidUrl('./sibling.html')).toBe(true)
      expect(isValidUrl('../parent/page')).toBe(true)
      expect(isValidUrl('page.html')).toBe(true)
    })

    it('accepts in-page anchors and query-only references', () => {
      expect(isValidUrl('#section')).toBe(true)
      expect(isValidUrl('?q=1')).toBe(true)
    })

    it('accepts protocol-relative URLs', () => {
      expect(isValidUrl('//example.com')).toBe(true)
    })
  })

  describe('data tokens', () => {
    it('accepts a bare token', () => {
      expect(isValidUrl('{currentEntry.permalink}')).toBe(true)
    })

    it('accepts a token composed into a relative path', () => {
      expect(isValidUrl('/blog/{currentEntry.slug}')).toBe(true)
    })

    it('accepts a token composed into an absolute URL', () => {
      expect(isValidUrl('https://example.com/{currentEntry.slug}')).toBe(true)
    })
  })

  describe('malformed input', () => {
    it('rejects plain text containing spaces', () => {
      expect(isValidUrl('not a url')).toBe(false)
    })

    it('rejects a relative path containing whitespace', () => {
      expect(isValidUrl('/relative/pa th')).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// isValidImageUrl
// ---------------------------------------------------------------------------

describe('isValidImageUrl', () => {
  describe('empty / falsy values', () => {
    it('returns true for empty string (render() returns empty html for empty src)', () => {
      expect(isValidImageUrl('')).toBe(true)
    })
  })

  describe('allowed protocols', () => {
    it('accepts https:', () => {
      expect(isValidImageUrl('https://example.com/image.png')).toBe(true)
    })

    it('accepts http:', () => {
      expect(isValidImageUrl('http://example.com/image.jpg')).toBe(true)
    })

    it('accepts data:image/png;base64', () => {
      expect(isValidImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    })

    it('accepts data:image/jpeg', () => {
      expect(isValidImageUrl('data:image/jpeg;base64,/9j/4AAQ=')).toBe(true)
    })

    it('accepts data:image/svg+xml', () => {
      expect(isValidImageUrl('data:image/svg+xml;base64,PHN2Zy8+')).toBe(true)
    })

    it('accepts data:image/gif', () => {
      expect(isValidImageUrl('data:image/gif;base64,R0lGODlh')).toBe(true)
    })

    it('accepts data:image/webp', () => {
      expect(isValidImageUrl('data:image/webp;base64,UklGRg==')).toBe(true)
    })
  })

  describe('rejected protocols', () => {
    it('rejects javascript:', () => {
      expect(isValidImageUrl('javascript:alert(1)')).toBe(false)
    })

    it('rejects data:text/html', () => {
      expect(isValidImageUrl('data:text/html,<h1>hi</h1>')).toBe(false)
    })

    it('rejects data:application/javascript', () => {
      expect(isValidImageUrl('data:application/javascript,alert(1)')).toBe(false)
    })

    it('rejects data:application/octet-stream', () => {
      expect(isValidImageUrl('data:application/octet-stream;base64,abc')).toBe(false)
    })

    it('rejects mailto: (not valid for image src)', () => {
      expect(isValidImageUrl('mailto:user@example.com')).toBe(false)
    })

    it('rejects ftp:', () => {
      expect(isValidImageUrl('ftp://files.example.com/image.png')).toBe(false)
    })

    it('rejects blob:', () => {
      expect(isValidImageUrl('blob:https://example.com/abc-123')).toBe(false)
    })

    it('rejects file:', () => {
      expect(isValidImageUrl('file:///home/user/image.png')).toBe(false)
    })
  })

  describe('malformed input', () => {
    it('rejects plain text', () => {
      expect(isValidImageUrl('not a url')).toBe(false)
    })

    it('rejects relative path', () => {
      expect(isValidImageUrl('/images/photo.png')).toBe(false)
    })

    it('rejects protocol-relative URL', () => {
      expect(isValidImageUrl('//example.com/image.png')).toBe(false)
    })
  })

  describe('allowlist boundaries — isValidUrl vs isValidImageUrl differ', () => {
    it('mailto: is valid for isValidUrl but not isValidImageUrl', () => {
      const url = 'mailto:user@example.com'
      expect(isValidUrl(url)).toBe(true)
      expect(isValidImageUrl(url)).toBe(false)
    })

    it('data:image/* is valid for isValidImageUrl but not isValidUrl', () => {
      const url = 'data:image/png;base64,abc='
      expect(isValidUrl(url)).toBe(false)
      expect(isValidImageUrl(url)).toBe(true)
    })

    it('relative references are valid for isValidUrl but not isValidImageUrl', () => {
      const url = '/images/photo.png'
      expect(isValidUrl(url)).toBe(true)
      expect(isValidImageUrl(url)).toBe(false)
    })
  })
})
