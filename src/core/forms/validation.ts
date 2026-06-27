import type {
  DataField,
  DataTable,
} from '@core/data/schemas'
import type {
  FormControlBinding,
  FormSubmissionLimits,
  FormValidationError,
} from './schemas'

const DEFAULT_MAX_FIELDS = 100
const DEFAULT_MAX_STRING_LENGTH = 10_000

type FormValidationResult =
  | { ok: true; cells: Record<string, unknown> }
  | { ok: false; errors: FormValidationError[] }

export function validateFormSubmission(input: {
  table: DataTable
  controls: FormControlBinding[]
  values: Record<string, unknown>
  limits?: FormSubmissionLimits
}): FormValidationResult {
  const limits = input.limits ?? {}
  const errors: FormValidationError[] = []
  const cells: Record<string, unknown> = {}
  const maxFields = limits.maxFields ?? DEFAULT_MAX_FIELDS
  const maxStringLength = limits.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH

  const controlByName = new Map<string, FormControlBinding>()
  const fieldById = new Map(input.table.fields.map((field) => [field.id, field]))
  for (const control of input.controls) {
    controlByName.set(control.name ?? control.fieldId, control)
  }

  const entries = Object.entries(input.values)
  if (entries.length > maxFields) {
    errors.push({
      fieldId: '*',
      code: 'too_many_fields',
      message: 'Too many fields submitted.',
    })
  }

  for (const [name, rawValue] of entries) {
    const control = controlByName.get(name)
    if (!control) {
      errors.push({
        fieldId: name,
        code: 'unknown_field',
        message: 'Unknown field.',
      })
      continue
    }

    const field = fieldById.get(control.fieldId)
    if (!field) {
      errors.push({
        fieldId: control.fieldId,
        code: 'unknown_field',
        message: 'Unknown field.',
      })
      continue
    }

    const coerced = coerceFieldValue(field, rawValue)
    if (!coerced.ok) {
      errors.push({ fieldId: field.id, code: coerced.code, message: coerced.message })
      continue
    }

    const validationError = validateCoercedValue(field, control, coerced.value, maxStringLength)
    if (validationError) {
      errors.push(validationError)
      continue
    }

    cells[field.id] = coerced.value
  }

  for (const control of input.controls) {
    const field = fieldById.get(control.fieldId)
    if (!field) continue
    const name = control.name ?? control.fieldId
    const required = control.required ?? Boolean(field.required)
    if (Object.hasOwn(input.values, name)) continue
    if (!required && field.type === 'boolean') {
      cells[field.id] = false
      continue
    }
    if (!required) continue
    errors.push({
      fieldId: field.id,
      code: 'required',
      message: 'This field is required.',
    })
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, cells }
}

type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string }

function coerceFieldValue(field: DataField, value: unknown): CoerceResult {
  if (value === '' || value === null || value === undefined) return { ok: true, value: null }

  switch (field.type) {
    case 'text':
    case 'longText':
    case 'richText':
    case 'url':
    case 'email':
    case 'date':
    case 'dateTime':
    case 'select':
      return { ok: true, value: String(value) }
    case 'number': {
      const numberValue = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(numberValue)
        ? { ok: true, value: numberValue }
        : { ok: false, code: 'invalid_number', message: 'Enter a valid number.' }
    }
    case 'boolean':
      return { ok: true, value: coerceBoolean(value) }
    case 'multiSelect':
      return Array.isArray(value)
        ? { ok: true, value: value.map(String) }
        : { ok: true, value: [String(value)] }
    case 'media':
      if (field.allowMultiple) {
        return Array.isArray(value)
          ? { ok: true, value: value.map(String) }
          : { ok: true, value: [String(value)] }
      }
      return { ok: true, value: String(value) }
    case 'relation':
      if (field.allowMultiple) {
        return Array.isArray(value)
          ? { ok: true, value: value.map(String) }
          : { ok: true, value: [String(value)] }
      }
      return { ok: true, value: String(value) }
    case 'pageTree':
    case 'fieldSchema':
    case 'seoMetadata':
      return { ok: false, code: 'unsupported_field', message: 'This field cannot be submitted by a form.' }
  }
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const normalized = String(value).toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'yes'
}

function validateCoercedValue(
  field: DataField,
  control: FormControlBinding,
  value: unknown,
  maxStringLength: number,
): FormValidationError | null {
  const required = control.required ?? Boolean(field.required)
  if (required && (value === null || value === '')) {
    return { fieldId: field.id, code: 'required', message: 'This field is required.' }
  }
  if (value === null) return null

  if (typeof value === 'string') {
    const maxLength = control.maxLength ?? ('maxLength' in field ? field.maxLength : undefined) ?? maxStringLength
    if (value.length > maxLength) {
      return {
        fieldId: field.id,
        code: 'too_long',
        message: `Must be ${maxLength} characters or fewer.`,
      }
    }
    if (control.minLength !== undefined && value.length < control.minLength) {
      return {
        fieldId: field.id,
        code: 'too_short',
        message: `Must be at least ${control.minLength} characters.`,
      }
    }
    if (field.type === 'email' && !isValidEmail(value)) {
      return { fieldId: field.id, code: 'invalid_email', message: 'Enter a valid email address.' }
    }
    if (field.type === 'url' && !isValidUrl(value)) {
      return { fieldId: field.id, code: 'invalid_url', message: 'Enter a valid URL.' }
    }
    if (control.pattern) {
      let regex: RegExp
      try {
        regex = new RegExp(control.pattern)
      } catch {
        return {
          fieldId: field.id,
          code: 'invalid_pattern',
          message: 'This field has an invalid validation pattern.',
        }
      }
      if (!regex.test(value)) {
        return { fieldId: field.id, code: 'pattern_mismatch', message: 'Use the requested format.' }
      }
    }
  }

  if (typeof value === 'number') {
    const min = control.min ?? ('min' in field ? field.min : undefined)
    const max = control.max ?? ('max' in field ? field.max : undefined)
    if (min !== undefined && value < min) {
      return { fieldId: field.id, code: 'too_small', message: `Must be at least ${min}.` }
    }
    if (max !== undefined && value > max) {
      return { fieldId: field.id, code: 'too_large', message: `Must be ${max} or less.` }
    }
  }

  if (field.type === 'select' && typeof value === 'string') {
    const allowed = new Set(field.options.map((option) => option.id))
    if (!allowed.has(value)) {
      return { fieldId: field.id, code: 'invalid_option', message: 'Choose one of the allowed options.' }
    }
  }

  if (field.type === 'multiSelect' && Array.isArray(value)) {
    const allowed = new Set(field.options.map((option) => option.id))
    if (value.some((item) => !allowed.has(String(item)))) {
      return { fieldId: field.id, code: 'invalid_option', message: 'Choose one of the allowed options.' }
    }
  }

  return null
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
