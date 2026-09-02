/** Shared row-shape helpers — no Directus arrays leak out of flatteners. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const rec = asRecord(entry)
        return rec ? [rec] : []
      })
    : []
}

export function relationId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value
  const rec = asRecord(value)
  if (typeof rec?.id === 'string' && rec.id) return rec.id
  return undefined
}

export function relationCode(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[A-Z]{2}$/i.test(value)) return value.toUpperCase()
  const rec = asRecord(value)
  if (typeof rec?.code === 'string' && rec.code) return rec.code.toUpperCase()
  if (typeof rec?.slug === 'string' && /^[A-Z]{2}$/i.test(rec.slug)) return rec.slug.toUpperCase()
  return undefined
}

export function stringField(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

export function numberField(rec: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

export function boolField(rec: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = rec[key]
    if (value === true || value === 1 || value === '1' || value === 'true') return true
  }
  return false
}

export function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    return items.length > 0 ? items : undefined
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[\s,]+/).filter(Boolean)
  }
  return undefined
}

export function assetUrl(baseUrl: string, value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (value.startsWith('http://') || value.startsWith('https://')) return value
    if (value) return `${baseUrl.replace(/\/+$/, '')}/assets/${value}`
    return undefined
  }
  const rec = asRecord(value)
  if (!rec) return undefined
  if (typeof rec.filename_download === 'string' && typeof rec.id === 'string') {
    return `${baseUrl.replace(/\/+$/, '')}/assets/${rec.id}`
  }
  if (typeof rec.id === 'string' && rec.id) {
    return `${baseUrl.replace(/\/+$/, '')}/assets/${rec.id}`
  }
  if (typeof rec.url === 'string' && rec.url) return rec.url
  return undefined
}

export function filteredCount(meta: { filter_count?: number; total_count?: number } | undefined, fallback: number): number {
  if (typeof meta?.filter_count === 'number' && Number.isFinite(meta.filter_count)) {
    return meta.filter_count
  }
  return fallback
}
