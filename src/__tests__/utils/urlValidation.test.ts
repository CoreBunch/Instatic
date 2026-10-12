import { describe, it, expect } from 'bun:test'
import { isValidUrl, isValidImageUrl } from '@core/utils/urlValidation'
import { isSafeUrl } from '@core/html-sanitize'

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

    it('accepts tel: and sms:, which the publisher also keeps in an href', () => {
      expect(isValidUrl('tel:+15551234567')).toBe(true)
      expect(isValidUrl('TEL:+15551234567')).toBe(true)
      expect(isValidUrl('sms:+15551234567')).toBe(true)
      expect(isValidUrl('sms:+15551234567?body=Hello')).toBe(true)
    })

    it('accepts every scheme the publisher lets through, so no publishable link is unenterable', () => {
      for (const url of ['https://a.test', 'http://a.test', 'mailto:a@a.test', 'tel:+1555', 'sms:+1555']) {
        expect(isSafeUrl(url)).toBe(true)
        expect(isValidUrl(url)).toBe(true)
      }
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

  describe('malformed input', () => {
    it('rejects plain text without protocol', () => {
      expect(isValidUrl('not a url')).toBe(false)
    })

    it('rejects a bare word, which is a typo or an unfinished URL far more often than a relative link', () => {
      expect(isValidUrl('about')).toBe(false)
      expect(isValidUrl('h')).toBe(false)
      expect(isValidUrl('example.com')).toBe(false)
    })

    it('rejects protocol-relative URLs', () => {
      expect(isValidUrl('//example.com')).toBe(false)
    })
  })

  describe('site-relative links', () => {
    it('accepts a root path, with or without query and fragment', () => {
      expect(isValidUrl('/')).toBe(true)
      expect(isValidUrl('/relative/path')).toBe(true)
      expect(isValidUrl('/pricing?plan=pro#faq')).toBe(true)
    })

    it('accepts a fragment, a query, and dot paths', () => {
      expect(isValidUrl('#')).toBe(true)
      expect(isValidUrl('#pricing')).toBe(true)
      expect(isValidUrl('?page=2')).toBe(true)
      expect(isValidUrl('./sibling')).toBe(true)
      expect(isValidUrl('../parent')).toBe(true)
    })

    it('rejects one containing whitespace', () => {
      expect(isValidUrl('/about us')).toBe(false)
      expect(isValidUrl('# pricing')).toBe(false)
    })

    it('still rejects a script scheme hidden behind leading whitespace or control characters', () => {
      expect(isValidUrl(' javascript:alert(1)')).toBe(false)
      expect(isValidUrl('\tjavascript:alert(1)')).toBe(false)
      expect(isValidUrl('/\njavascript:alert(1)')).toBe(false)
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
  })
})
