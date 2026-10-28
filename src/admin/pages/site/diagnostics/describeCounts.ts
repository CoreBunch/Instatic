/**
 * The heading above a diagnostics list: "3 errors · 1 warning".
 *
 * Its own module because `RuntimeDiagnosticsList.tsx` exports components, and
 * Fast Refresh only works when a component file exports nothing else.
 */
export function describeCounts(errors: number, warnings: number): string {
  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`)
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  return parts.join(' · ') || 'No problems'
}
