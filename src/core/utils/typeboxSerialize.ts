/** Preserve TypeBox's declarative symbols across the module-pack JSON boundary. */
export function serializeTypeBoxSchema(schema: unknown): string | undefined {
  if (schema === undefined) return undefined
  const annotations: Array<{ path: string[]; symbols: Record<string, string> }> = []
  function visit(value: unknown, path: string[], ancestors: Set<object>): void {
    if (!value || typeof value !== 'object') return
    if (ancestors.has(value)) throw new Error('Cyclic module schemas cannot cross the sandbox boundary')
    const record = value as Record<string | symbol, unknown>
    if (Symbol.for('TypeBox.Transform') in record) throw new Error('Module schemas must be declarative; TypeBox transforms cannot cross the sandbox boundary')
    const symbols: Record<string, string> = {}
    for (const name of ['Kind', 'Optional', 'Readonly', 'Hint']) {
      const entry = record[Symbol.for('TypeBox.' + name)]
      if (typeof entry === 'string') symbols[name] = entry
    }
    if (Object.keys(symbols).length > 0) annotations.push({ path, symbols })
    const next = new Set(ancestors).add(value)
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key], next)
  }
  visit(schema, [], new Set())
  // Separate metadata never reserves keys inside a schema's authored default.
  return JSON.stringify({ schema, annotations })
}
