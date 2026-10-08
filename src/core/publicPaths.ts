/** URL namespaces owned by the server, shared by page and file authoring. */
const RESERVED_PUBLIC_PREFIXES = new Set(['admin', 'api', 'assets', 'health', 'uploads', '_instatic'])

export function isReservedPublicPath(path: string): boolean {
  const firstSegment = path.replace(/^\//, '').split('/')[0]?.toLowerCase() ?? ''
  return RESERVED_PUBLIC_PREFIXES.has(firstSegment)
}
