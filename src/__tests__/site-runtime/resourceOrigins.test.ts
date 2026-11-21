import { describe, expect, it } from 'bun:test'
import { normalizeResourceOrigins, normalizeScriptRuntimeConfig, parseResourceOrigin } from '@core/site-runtime'

describe('runtime resource origins', () => {
  it('retains stylesheet-only and font-only declarations and rejects unsafe origins', () => {
    expect(normalizeResourceOrigins({ styles: ['https://CDN.example/', 'https://cdn.example', '*'], fonts: ['https://fonts.example', 'data:font/woff2,x'] }))
      .toEqual({ scripts: [], frames: [], connections: [], styles: ['https://cdn.example'], fonts: ['https://fonts.example'] })
    expect(normalizeResourceOrigins({ styles: ['https://cdn.example/a.css'], fonts: ["'self'"] })).toBeUndefined()
  })
  it('canonicalizes and deduplicates HTTP origins, retaining explicit ports', () => {
    expect(normalizeResourceOrigins({ scripts: ['https://EXAMPLE.com/', 'https://example.com', 'http://localhost:3001'], frames: [], connections: [] }))
      .toEqual({ scripts: ['http://localhost:3001', 'https://example.com'], frames: [], connections: [] })
  })

  it('rejects credentials, paths, CSP syntax and encoded authority punctuation', () => {
    for (const value of ["'unsafe-inline'", '*', 'https://*.example.com', 'data:text/javascript,x', 'javascript:alert(1)',
      '//example.com', 'https://user:pass@example.com', 'https://example.com/a', 'https://example.com/../',
      'https://example.com?x=1', 'https://example.com#x', "https://evil%27.example", 'https://evil%3b.example',
      'https://evil%2a.example', 'https://example.com; script-src *', 'https://example.com\\evil']) {
      expect(parseResourceOrigin(value)).toBeNull()
    }
    expect(normalizeScriptRuntimeConfig({ resourceOrigins: { scripts: ['*'], frames: [], connections: [] } }).resourceOrigins).toBeUndefined()
  })
})
