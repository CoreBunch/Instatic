/**
 * Deterministic JSON serialisation — object keys sorted at every depth, so two
 * structurally equal values always produce the same string. The input to
 * every content hash (publish snapshots, branch bases).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}
