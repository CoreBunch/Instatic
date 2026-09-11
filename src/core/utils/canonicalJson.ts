/**
 * Deterministic JSON serialisation: object keys sorted at every depth, so two
 * structurally equal values always produce the same string. The input to
 * every content hash (publish snapshots, branch bases). `undefined` follows
 * `JSON.stringify` (dropped from objects, `null` in arrays), so an in-memory
 * value hashes the same as its stored JSON.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(',')}}`
  }
  return value === undefined ? 'null' : JSON.stringify(value)
}
