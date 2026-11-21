/**
 * Dialect-agnostic classification of database errors. Repositories must not
 * import driver error classes, so these match on what both drivers put in the
 * message: Postgres sqlstate 23505 / "duplicate key", SQLite "UNIQUE
 * constraint failed".
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('unique') || msg.includes('23505') || msg.includes('duplicate')
}
