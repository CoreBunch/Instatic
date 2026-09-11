/**
 * Unit tests for makeOption() in the New Field dialog model.
 *
 * Regression cover for the crash reported in #319: `crypto.randomUUID()` is
 * only defined in a secure context, so any admin reached over plain HTTP on a
 * LAN address or bare hostname (the common Docker Compose setup) has no such
 * function and the dialog throws on open. Option ids must be generated with a
 * primitive that does not depend on secure-context availability.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { DataFieldSchema } from '@core/data/schemas'
import { fieldIdError, makeOption, slugifyOptionValue } from '@admin/pages/data/components/NewFieldDialog/newFieldDialogModel'
import {
  POST_TYPE_FIELD_FEATURED_MEDIA,
  POST_TYPE_FIELD_SEO_DESCRIPTION,
  POST_TYPE_FIELD_SEO_TITLE,
} from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `fn` with `crypto.randomUUID` absent, mirroring an insecure browsing
 * context. Restores the original descriptor afterwards.
 */
function withoutRandomUUID<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: undefined,
    configurable: true,
    writable: true,
  })
  try {
    return fn()
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original)
    else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID
  }
}

afterEach(() => {
  expect(typeof globalThis.crypto.randomUUID).toBe('function')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeOption', () => {
  it('produces an option in a secure context', () => {
    const option = makeOption('In stock')
    expect(option.label).toBe('In stock')
    expect(option.value).toBe('in_stock')
    expect(option.id).toBeTruthy()
  })

  it('produces an option in an insecure context, where crypto.randomUUID is undefined', () => {
    const option = withoutRandomUUID(() => makeOption('In stock'))
    expect(option.label).toBe('In stock')
    expect(option.value).toBe('in_stock')
    expect(option.id).toBeTruthy()
  })

  it('generates distinct ids in an insecure context', () => {
    const ids = withoutRandomUUID(() =>
      Array.from({ length: 100 }, () => makeOption('Option').id),
    )
    expect(new Set(ids).size).toBe(100)
  })

  it('keeps select options schema-valid when generated in an insecure context', () => {
    const options = withoutRandomUUID(() =>
      ['Draft', 'Published'].map((label) => {
        const option = makeOption(label)
        return { id: option.id, label, value: option.value || slugifyOptionValue(label) }
      }),
    )
    const field = { type: 'select', id: 'status', label: 'Status', options }
    expect(Value.Check(DataFieldSchema, field)).toBe(true)
  })
})

describe('fieldIdError', () => {
  it('accepts camelCase, the convention the built-in fields already use', () => {
    for (const id of ['firmaUrl', 'interviewUrl', 'aufStartseite', 'seoTitle']) {
      expect(fieldIdError(id, [])).toBeNull()
    }
  })

  it("accepts Instatic's own built-in post-type field ids", () => {
    // The regression in #434: the dialog rejected ids that the product itself
    // ships, so one table could end up holding two naming conventions.
    for (const id of [
      POST_TYPE_FIELD_FEATURED_MEDIA,
      POST_TYPE_FIELD_SEO_TITLE,
      POST_TYPE_FIELD_SEO_DESCRIPTION,
    ]) {
      expect(id).toMatch(/[A-Z]/)
      expect(fieldIdError(id, [])).toBeNull()
    }
  })

  it('still accepts snake_case, so nothing that validated before stops', () => {
    for (const id of ['firma_url', 'title', 'field_1', 'a']) {
      expect(fieldIdError(id, [])).toBeNull()
    }
  })

  it('still requires a lowercase first character', () => {
    for (const id of ['FirmaUrl', '_leading', '1st', 'Ärger']) {
      expect(fieldIdError(id, [])).not.toBeNull()
    }
  })

  it('still rejects characters that are unsafe as a token key', () => {
    for (const id of ['firma-url', 'firma url', 'firma.url', 'firma$url']) {
      expect(fieldIdError(id, [])).not.toBeNull()
    }
  })

  it('reports an empty id as no error, leaving the submit gate to handle it', () => {
    expect(fieldIdError('', [])).toBeNull()
  })

  it('still flags a duplicate id ahead of the pattern message', () => {
    expect(fieldIdError('firmaUrl', ['firmaUrl'])).toBe('This ID is already in use.')
  })
})
