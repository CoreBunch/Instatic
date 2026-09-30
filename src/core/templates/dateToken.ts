/** Explicit date formatting keeps stored ISO dates sortable and display text localised. */
export function resolveDateToken(frame: Record<string, unknown>, field: string): string | undefined {
  const match = /^([\w.]+):date\(([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*),(full|long|medium|short)\)$/.exec(field)
  if (!match) return undefined
  let value: unknown = frame
  for (const part of match[1]!.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return ''
    value = (value as Record<string, unknown>)[part]
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return ''
  try {
    return new Intl.DateTimeFormat(match[2], {
      dateStyle: match[3] as 'full' | 'long' | 'medium' | 'short',
      timeZone: 'UTC',
    }).format(date)
  } catch {
    return ''
  }
}
