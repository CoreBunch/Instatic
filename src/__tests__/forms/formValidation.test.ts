import { describe, expect, it } from 'bun:test'
import type { DataTable } from '@core/data/schemas'
import { validateFormSubmission } from '@core/forms'

const table: DataTable = {
  id: 'newsletter_submissions',
  name: 'Newsletter submissions',
  slug: 'newsletter-submissions',
  kind: 'data',
  singularLabel: 'Submission',
  pluralLabel: 'Submissions',
  routeBase: '',
  primaryFieldId: 'email',
  system: false,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  fields: [
    { id: 'email', label: 'Email', type: 'email', required: true },
    { id: 'name', label: 'Name', type: 'text', maxLength: 12 },
    { id: 'plan', label: 'Plan', type: 'select', options: [
      { id: 'free', label: 'Free', value: 'free' },
      { id: 'pro', label: 'Pro', value: 'pro' },
    ] },
    { id: 'subscribed', label: 'Subscribed', type: 'boolean' },
  ],
}

const controls = [
  { nodeId: 'email-input', fieldId: 'email', required: true, inputType: 'email' },
  { nodeId: 'name-input', fieldId: 'name', maxLength: 12 },
  { nodeId: 'plan-select', fieldId: 'plan' },
  { nodeId: 'subscribed-checkbox', fieldId: 'subscribed' },
]

describe('validateFormSubmission', () => {
  it('coerces valid submitted values into data row cells', () => {
    const result = validateFormSubmission({
      table,
      controls,
      values: {
        email: 'AI@EXAMPLE.COM',
        name: 'Ada',
        plan: 'pro',
        subscribed: 'on',
      },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.cells).toEqual({
        email: 'AI@EXAMPLE.COM',
        name: 'Ada',
        plan: 'pro',
        subscribed: true,
      })
    }
  })

  it('rejects unknown fields instead of storing attacker-supplied cells', () => {
    const result = validateFormSubmission({
      table,
      controls,
      values: {
        email: 'ai@example.com',
        role: 'admin',
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        fieldId: 'role',
        code: 'unknown_field',
        message: 'Unknown field.',
      })
    }
  })

  it('reports required and type-specific validation errors', () => {
    const result = validateFormSubmission({
      table,
      controls,
      values: {
        email: 'not-an-email',
        name: 'Name that is too long',
        plan: 'enterprise',
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        fieldId: 'email',
        code: 'invalid_email',
        message: 'Enter a valid email address.',
      })
      expect(result.errors).toContainEqual({
        fieldId: 'name',
        code: 'too_long',
        message: 'Must be 12 characters or fewer.',
      })
      expect(result.errors).toContainEqual({
        fieldId: 'plan',
        code: 'invalid_option',
        message: 'Choose one of the allowed options.',
      })
    }
  })

  it('rejects payloads that exceed the configured field count', () => {
    const result = validateFormSubmission({
      table,
      controls,
      limits: { maxFields: 2 },
      values: {
        email: 'ai@example.com',
        name: 'Ada',
        plan: 'pro',
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        fieldId: '*',
        code: 'too_many_fields',
        message: 'Too many fields submitted.',
      })
    }
  })

  it('stores missing optional boolean controls as false', () => {
    const result = validateFormSubmission({
      table,
      controls,
      values: {
        email: 'ai@example.com',
      },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.cells.subscribed).toBe(false)
    }
  })

  it('reports invalid author-supplied regex patterns instead of throwing', () => {
    const result = validateFormSubmission({
      table,
      controls: [
        { nodeId: 'name-input', fieldId: 'name', pattern: '[' },
      ],
      values: {
        name: 'Ada',
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        fieldId: 'name',
        code: 'invalid_pattern',
        message: 'This field has an invalid validation pattern.',
      })
    }
  })
})

// Options created in the Data workspace get a generated id and a slug value.
// Form controls submit the value; the stored cell is the id.
const optionTable: DataTable = {
  ...table,
  id: 'contact_requests',
  primaryFieldId: 'topic',
  fields: [
    { id: 'topic', label: 'Topic', type: 'select', options: [
      { id: 'o1x9kq2v', label: 'General request', value: 'general_request' },
      { id: 'p4m2zt7w', label: 'Billing', value: 'billing' },
    ] },
    { id: 'channels', label: 'Channels', type: 'multiSelect', options: [
      { id: 'c8a1', label: 'Email', value: 'email' },
      { id: 'c8a2', label: 'Phone', value: 'phone' },
    ] },
  ],
}

const optionControls = [
  { nodeId: 'topic-select', fieldId: 'topic' },
  { nodeId: 'channels-select', fieldId: 'channels' },
]

describe('validateFormSubmission select options', () => {
  it('accepts the option value a form control submits and stores the option id', () => {
    const result = validateFormSubmission({
      table: optionTable,
      controls: optionControls,
      values: { topic: 'general_request', channels: ['email', 'phone'] },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.cells).toEqual({ topic: 'o1x9kq2v', channels: ['c8a1', 'c8a2'] })
    }
  })

  it('still accepts option ids, mixed with values for multiSelect', () => {
    const result = validateFormSubmission({
      table: optionTable,
      controls: optionControls,
      values: { topic: 'p4m2zt7w', channels: ['c8a1', 'phone'] },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.cells).toEqual({ topic: 'p4m2zt7w', channels: ['c8a1', 'c8a2'] })
    }
  })

  it('rejects options that match neither an id nor a value', () => {
    const result = validateFormSubmission({
      table: optionTable,
      controls: optionControls,
      values: { topic: 'General request', channels: ['email', 'fax'] },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toEqual([
        { fieldId: 'topic', code: 'invalid_option', message: 'Choose one of the allowed options.' },
        { fieldId: 'channels', code: 'invalid_option', message: 'Choose one of the allowed options.' },
      ])
    }
  })
})
