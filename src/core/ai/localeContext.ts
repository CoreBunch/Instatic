import { Type, parseValue, safeParseValue } from '@core/utils/typeboxHelpers'

const LocaleToolInputSchema = Type.Object({ localeId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: true })

/** Separate the shared language guard before a tool's own input validation. */
export function readLocaleToolInput(raw: unknown): { localeId?: string; input: Record<string, unknown> } {
  const value = parseValue(Type.Record(Type.String(), Type.Unknown()), raw)
  const { localeId } = parseValue(LocaleToolInputSchema, value)
  const input = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'localeId'))
  return { localeId, input }
}

const SnapshotLocaleSchema = Type.Object({
  localeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  site: Type.Optional(Type.Object({ localeId: Type.Optional(Type.String()) }, { additionalProperties: true })),
}, { additionalProperties: true })

export function toolLocaleId(input: unknown, snapshot: unknown): string | undefined {
  const requested = readLocaleToolInput(input).localeId
  if (requested) return requested
  if (snapshot === null || snapshot === undefined) return undefined
  const parsed = safeParseValue(SnapshotLocaleSchema, snapshot)
  return parsed.ok ? parsed.value.localeId ?? parsed.value.site?.localeId : undefined
}
