/**
 * Validate the narrow, official Google Maps Embed URL shape this module
 * supports. Keeping this fixed prevents a page author from widening CSP with
 * an arbitrary frame origin through a configurable URL field.
 */
export function googleMapsEmbedUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || host !== 'www.google.com' || url.pathname !== '/maps/embed') {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}
