/**
 * Clone validated JSON-shaped content without structuredClone: editor recipes
 * may pass Mutative proxies, which structuredClone cannot read. No source or
 * override object may become mutable through a materialized locale projection.
 */
export function cloneContentValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneContentValue) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneContentValue(entry)]),
    ) as T
  }
  return value
}
