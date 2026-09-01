import { describe, expect, it } from 'bun:test'
import {
  parsePluginManifest,
  validatePluginCspContributionRecord,
} from '@core/plugins/manifest'

const cspManagerManifest = {
  id: 'instatic.csp-manager',
  name: 'CSP Manager',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['admin.navigation', 'publisher.csp'],
  publisher: { csp: { resource: 'sources' } },
  resources: [{
    id: 'sources',
    title: 'CSP sources',
    fields: [
      { id: 'directive', label: 'Directive', type: 'text', required: true },
      { id: 'origin', label: 'HTTPS origin', type: 'text', required: true },
      { id: 'enabled', label: 'Enabled', type: 'boolean', required: true },
      { id: 'description', label: 'Description', type: 'longtext' },
    ],
  }],
  adminPages: [{
    id: 'policy',
    title: 'CSP Manager',
    content: { kind: 'resource', heading: 'Content Security Policy', resource: 'sources' },
  }],
}

describe('plugin CSP contributions', () => {
  it('accepts a permission-gated host-owned CSP resource declaration', () => {
    const manifest = parsePluginManifest(cspManagerManifest)
    expect(manifest.publisher?.csp.resource).toBe('sources')
  })

  it('rejects CSP declarations without publisher.csp or with the wrong resource shape', () => {
    expect(() => parsePluginManifest({
      ...cspManagerManifest,
      permissions: ['admin.navigation'],
    })).toThrow(/publisher\.csp/)

    expect(() => parsePluginManifest({
      ...cspManagerManifest,
      resources: [{
        ...cspManagerManifest.resources[0],
        fields: cspManagerManifest.resources[0].fields.filter((field) => field.id !== 'enabled'),
      }],
    })).toThrow(/enabled/)
  })

  it('accepts only the directive allowlist and exact canonical HTTPS origins', () => {
    expect(validatePluginCspContributionRecord({
      directive: 'script-src',
      origin: 'https://connect.facebook.net',
      enabled: true,
      description: 'Meta Pixel loader',
    })).toEqual({
      directive: 'script-src',
      origin: 'https://connect.facebook.net',
      enabled: true,
      description: 'Meta Pixel loader',
    })

    for (const directive of ['default-src', 'style-src', 'script-src; img-src', "'unsafe-inline'"]) {
      expect(() => validatePluginCspContributionRecord({
        directive,
        origin: 'https://example.com',
        enabled: true,
      })).toThrow()
    }

    for (const origin of [
      '*',
      'https://*.example.com',
      'http://example.com',
      'https://example.com/path',
      'https://example.com/?query=1',
      'https://example.com/#fragment',
      'https://user:pass@example.com',
      'https://example.com/',
      'https://EXAMPLE.com',
      'https://example.com:443',
      'https://example.com:99999',
      'https://exämple.com',
      "'unsafe-inline'",
      "'unsafe-eval'",
      'data:',
      'blob:',
      'https://example.com; img-src https://evil.example',
    ]) {
      expect(() => validatePluginCspContributionRecord({
        directive: 'connect-src',
        origin,
        enabled: true,
      })).toThrow()
    }
  })

  it('treats disabled rows as valid persisted configuration', () => {
    expect(validatePluginCspContributionRecord({
      directive: 'frame-src',
      origin: 'https://www.youtube.com',
      enabled: false,
    }).enabled).toBe(false)
  })
})
